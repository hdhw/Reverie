using System.Globalization;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Mocha2023.Auth;
using Mocha2023.Classes;
using Mocha2023.Classes.DBs;
using Mocha2023.Classes.DBs.DBClasses;

namespace Mocha2023.Controllers
{
    // Player events in the shapes the 2023 client reads. Mocha's original event endpoints
    // used their own field names, so created events never showed up in any list.
    // Wire shapes were checked against RecFlare's documented API (github.com/recflare/server, MIT).
    [ApiController]
    [ApiProtection]
    public class ReverieEventsController : ControllerBase
    {
        private const int MaxServed = 50;
        private const int MaxNameLength = 100;
        private const int MaxDescriptionLength = 1000;
        private static readonly TimeSpan DefaultDuration = TimeSpan.FromHours(1);
        private static readonly TimeSpan MaxDuration = TimeSpan.FromHours(24);

        private static readonly string[] AccessibilityNames = { "Private", "Public", "Unlisted" };
        private static readonly string[] ResponseNames = { "Going", "Interested", "NotGoing", "Pending" };
        private static readonly string[] Filters =
            { "workshops", "celebration", "game", "meetup", "performance", "coop", "grandopening", "class", "competition" };

        // ---------- projections ----------

        private static string Time(DateTime value) =>
            DateTime.SpecifyKind(value, DateTimeKind.Utc).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);

        private static DateTime EndOf(PlayerEventDB.PlayerEvent e) => e.EndsAt ?? e.StartsAt + DefaultDuration;

        private static int AccessibilityValue(string? name)
        {
            int index = Array.FindIndex(AccessibilityNames, n => n.Equals(name, StringComparison.OrdinalIgnoreCase));
            return index < 0 ? 1 : index;
        }

        private static int ResponseValue(string? name)
        {
            int index = Array.FindIndex(ResponseNames, n => n.Equals(name, StringComparison.OrdinalIgnoreCase));
            return index < 0 ? 0 : index;
        }

        private static int AttendeeCount(long eventId) =>
            PlayerEventDB.GetResponses(eventId).Count(r => ResponseValue(r.ResponseType) == 0);

        // The stored record: what by-id, search, live and club reads serve.
        private static Dictionary<string, object?> Record(PlayerEventDB.PlayerEvent e) => new()
        {
            ["PlayerEventId"] = e.EventId,
            ["CreatorPlayerId"] = e.CreatorAccountId,
            ["ImageName"] = string.IsNullOrEmpty(e.ImageName) ? null : e.ImageName,
            ["RoomId"] = e.RoomId ?? 0,
            ["SubRoomId"] = null,
            ["ClubId"] = e.ClubId,
            ["Name"] = e.Name,
            ["Description"] = e.Description,
            ["StartTime"] = Time(e.StartsAt),
            ["EndTime"] = Time(EndOf(e)),
            ["AttendeeCount"] = AttendeeCount(e.EventId),
            ["State"] = 0,
            ["Accessibility"] = AccessibilityValue(e.Accessibility),
            ["IsMultiInstance"] = e.MultiInstance,
            ["SupportMultiInstanceRoomChat"] = false,
            ["DefaultBroadcastPermissions"] = 0,
            ["CanRequestBroadcastPermissions"] = 0,
        };

        // The base event: what the browse feed, room shelf and bulk reads serve.
        private static Dictionary<string, object?> Base(PlayerEventDB.PlayerEvent e)
        {
            var d = Record(e);
            d.Remove("State");
            d["ImageName"] = e.ImageName ?? string.Empty;
            d["BroadcastingRoomInstanceId"] = null;
            return d;
        }

        private static object Envelope(PlayerEventDB.PlayerEvent e)
        {
            var d = Base(e);
            d["Tags"] = e.Tags;
            return new { PlayerEvent = d, Result = 0, TagModifyResult = new { Result = 0, Tags = e.Tags } };
        }

        private static object ResponseDto(PlayerEventDB.PlayerEventResponse r) => new
        {
            PlayerEventResponseId = r.AccountId,
            PlayerEventId = r.EventId,
            PlayerId = r.AccountId,
            CreatedAt = Time(r.CreatedAt),
            Type = ResponseValue(r.ResponseType),
        };

        private static IEnumerable<PlayerEventDB.PlayerEvent> Soonest(IEnumerable<PlayerEventDB.PlayerEvent> list) =>
            list.OrderBy(e => e.StartsAt).ThenBy(e => e.EventId);

        private static bool IsPublic(PlayerEventDB.PlayerEvent e) => AccessibilityValue(e.Accessibility) == 1;

        private static IEnumerable<PlayerEventDB.PlayerEvent> Upcoming() =>
            PlayerEventDB.GetAll().Where(e => IsPublic(e) && EndOf(e) >= DateTime.UtcNow);

        private static int Take(int? take) => take is > 0 and <= MaxServed ? take.Value : MaxServed;

        // ---------- input ----------

        private static List<string> ParseTags(JsonElement raw)
        {
            if (raw.ValueKind != JsonValueKind.Array) return new List<string>();
            var tags = new List<string>();
            foreach (var entry in raw.EnumerateArray())
            {
                string? name = entry.ValueKind == JsonValueKind.String ? entry.GetString()
                    : entry.ValueKind == JsonValueKind.Object && (entry.TryGetProperty("Tag", out var t) || entry.TryGetProperty("tag", out t)) ? t.GetString()
                    : null;
                name = name?.Trim().TrimStart('#').ToLowerInvariant();
                if (!string.IsNullOrEmpty(name) && !tags.Contains(name)) tags.Add(name);
            }
            return tags.Take(20).ToList();
        }

        private static bool TryTime(string? raw, out DateTime value)
        {
            bool ok = DateTime.TryParse(raw, CultureInfo.InvariantCulture,
                DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out value);
            value = DateTime.SpecifyKind(value, DateTimeKind.Utc);
            return ok;
        }

        // Applies the JSON event body (bare or wrapped in "PlayerEvent"). Returns an error or null.
        private static string? Apply(PlayerEventDB.PlayerEvent e, JsonElement body)
        {
            if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("PlayerEvent", out var inner) && inner.ValueKind == JsonValueKind.Object)
                body = inner;
            if (body.ValueKind != JsonValueKind.Object) return "Expected a JSON object.";

            JsonElement v;
            if (body.TryGetProperty("Name", out v) && v.ValueKind == JsonValueKind.String) e.Name = v.GetString()!.Trim();
            if (body.TryGetProperty("Description", out v) && v.ValueKind == JsonValueKind.String) e.Description = v.GetString()!;
            if (body.TryGetProperty("ImageName", out v)) e.ImageName = v.ValueKind == JsonValueKind.String ? v.GetString()! : string.Empty;
            if (body.TryGetProperty("RoomId", out v) && v.TryGetInt64(out long room)) e.RoomId = room > 0 ? room : null;
            if (body.TryGetProperty("ClubId", out v)) e.ClubId = v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out long club) && club > 0 ? club : null;
            if (body.TryGetProperty("Accessibility", out v) && v.TryGetInt32(out int access) && access is >= 0 and <= 2) e.Accessibility = AccessibilityNames[access];
            if (body.TryGetProperty("IsMultiInstance", out v) && v.ValueKind is JsonValueKind.True or JsonValueKind.False) e.MultiInstance = v.GetBoolean();
            if (body.TryGetProperty("Tags", out v) || body.TryGetProperty("tags", out v)) e.Tags = ParseTags(v);
            if (body.TryGetProperty("StartTime", out v))
            {
                if (!TryTime(v.GetString(), out var start)) return "Start time is not a date.";
                e.StartsAt = start;
            }
            if (body.TryGetProperty("EndTime", out v))
            {
                if (!TryTime(v.GetString(), out var end)) return "End time is not a date.";
                e.EndsAt = end;
            }
            return Validate(e);
        }

        private static string? Validate(PlayerEventDB.PlayerEvent e)
        {
            if (e.Name.Length > MaxNameLength) return $"Event names can be at most {MaxNameLength} characters.";
            if (e.Description.Length > MaxDescriptionLength) return $"Event descriptions can be at most {MaxDescriptionLength} characters.";
            if (EndOf(e) < e.StartsAt) return "An event cannot end before it starts.";
            if (EndOf(e) - e.StartsAt > MaxDuration) return "An event can run for at most 24 hours.";
            return null;
        }

        private async Task<JsonElement> JsonBody()
        {
            try { return await JsonSerializer.DeserializeAsync<JsonElement>(Request.Body); }
            catch (JsonException) { return default; }
        }

        private async Task<string?> Field(string name)
        {
            if (Request.HasFormContentType)
            {
                var form = await Request.ReadFormAsync();
                foreach (var key in form.Keys)
                    if (key.Equals(name, StringComparison.OrdinalIgnoreCase)) return form[key].ToString();
                return null;
            }
            var body = await JsonBody();
            if (body.ValueKind != JsonValueKind.Object) return null;
            foreach (var p in body.EnumerateObject())
                if (p.Name.Equals(name, StringComparison.OrdinalIgnoreCase) || p.Name.Equals("Value", StringComparison.OrdinalIgnoreCase))
                    return p.Value.ValueKind == JsonValueKind.String ? p.Value.GetString() : p.Value.ToString();
            return null;
        }

        private static bool CanManage(PlayerEventDB.PlayerEvent e, long accountId)
        {
            if (e.CreatorAccountId == accountId) return true;
            var roles = PlayerDB.Players.FindById(accountId)?.PlayerRoles;
            return roles?.Contains(PlayerDBClasses.PlayerRoles.Developer) == true ||
                   roles?.Contains(PlayerDBClasses.PlayerRoles.Moderator) == true;
        }

        private List<long> QueryIds() =>
            Request.Query["id"].SelectMany(v => (v ?? string.Empty).Split(',', StringSplitOptions.RemoveEmptyEntries))
                .Select(s => long.TryParse(s.Trim(), out long id) ? id : 0).Where(id => id > 0).Distinct().ToList();

        // ---------- reads ----------

        [HttpGet("/api/playerevents/v1")]
        public IActionResult Feed([FromQuery] int skip = 0, [FromQuery] int? take = null) =>
            Ok(Soonest(Upcoming()).Skip(Math.Max(0, skip)).Take(Take(take)).Select(Base));

        [HttpGet("/api/playerevents/v1/all")]
        public IActionResult Mine()
        {
            long? me = AuthStuff.GetPlayerId(Request);
            if (me == null) return Unauthorized();
            return Ok(MineFor(me.Value, publicOnly: false));
        }

        [HttpGet("/api/playerevents/v1/all/{playerId:long}")]
        public IActionResult ForPlayer(long playerId) => Ok(MineFor(playerId, publicOnly: true));

        private static object MineFor(long playerId, bool publicOnly)
        {
            var created = Soonest(PlayerEventDB.GetByCreator(playerId).Where(e => !publicOnly || IsPublic(e)))
                .TakeLast(MaxServed).Select(Record).ToList();
            var responses = PlayerEventDB.GetResponsesByAccount(playerId)
                .Select(r => (Response: r, Event: PlayerEventDB.Get(r.EventId)))
                .Where(x => x.Event != null && x.Event.CreatorAccountId != playerId && (!publicOnly || IsPublic(x.Event)))
                .OrderBy(x => x.Event!.StartsAt)
                .TakeLast(MaxServed)
                .Select(x => new { PlayerEvent = Record(x.Event!), PlayerEventResponse = ResponseDto(x.Response) })
                .ToList();
            return new { Created = created, Responses = responses };
        }

        [HttpGet("/api/playerevents/v1/tagfilters")]
        [HttpGet("/api/playerevents/v1/filters")]
        public IActionResult TagFilters() =>
            Ok(new { PinnedFilters = Filters, PopularFilters = Filters, TrendingFilters = (string[]?)null });

        [HttpGet("/api/playerevents/v1/search")]
        public IActionResult Search([FromQuery] string? query = null, [FromQuery] string? sort = null, [FromQuery] int skip = 0, [FromQuery] int? take = null)
        {
            var terms = (query ?? string.Empty).ToLowerInvariant().Split(' ', StringSplitOptions.RemoveEmptyEntries);
            var tags = terms.Where(t => t.StartsWith('#')).Select(t => t[1..]).Where(t => t.Length > 0).ToList();
            var words = terms.Where(t => !t.StartsWith('#')).ToList();
            var events = Upcoming().Where(e =>
                tags.All(t => e.Tags.Contains(t)) &&
                words.All(w => e.Name.Contains(w, StringComparison.OrdinalIgnoreCase) || e.Description.Contains(w, StringComparison.OrdinalIgnoreCase)));
            var ordered = string.Equals(sort, "attendance", StringComparison.OrdinalIgnoreCase)
                ? events.OrderByDescending(e => AttendeeCount(e.EventId)).ThenBy(e => e.StartsAt)
                : Soonest(events);
            return Ok(ordered.Skip(Math.Max(0, skip)).Take(Take(take)).Select(Record));
        }

        [HttpGet("/api/playerevents/v1/searchlive")]
        public IActionResult Live()
        {
            var now = DateTime.UtcNow;
            return Ok(Soonest(Upcoming().Where(e => e.StartsAt <= now)).Take(MaxServed).Select(Record));
        }

        [HttpGet("/api/playerevents/v1/room/{roomId:long}")]
        public IActionResult ForRoom(long roomId) =>
            Ok(Soonest(Upcoming().Where(e => e.RoomId == roomId)).Take(MaxServed).Select(Base));

        [HttpGet("/api/playerevents/v1/clubs")]
        public IActionResult ForClubs()
        {
            var ids = QueryIds();
            if (ids.Count == 0 && AuthStuff.GetPlayerId(Request) is long me)
                ids = ClubDB.GetMemberClubs(me).Select(c => c.ClubId).ToList();
            var events = ids.SelectMany(PlayerEventDB.GetByClub).DistinctBy(e => e.EventId);
            return Ok(Soonest(events).TakeLast(MaxServed).Select(Record));
        }

        [HttpGet("/api/playerevents/v1/club/{clubId:long}")]
        public IActionResult ForClub(long clubId) =>
            Ok(new { ContinuationToken = string.Empty, Events = Soonest(PlayerEventDB.GetByClub(clubId)).TakeLast(MaxServed).Select(Record) });

        [HttpGet("/api/playerevents/v1/bulk")]
        public IActionResult BulkGet() => Ok(PlayerEventDB.GetByIds(QueryIds().Take(MaxServed)).Select(Base));

        [HttpPost("/api/playerevents/v1/bulk")]
        public async Task<IActionResult> BulkPost()
        {
            var ids = new List<long>();
            if (Request.HasFormContentType)
            {
                var form = await Request.ReadFormAsync();
                foreach (var key in new[] { "Ids", "ids", "id" })
                    foreach (var v in form[key])
                        foreach (var part in (v ?? string.Empty).Split(','))
                            if (long.TryParse(part.Trim(), out long id)) ids.Add(id);
            }
            else
            {
                var body = await JsonBody();
                var list = body.ValueKind == JsonValueKind.Array ? body
                    : body.ValueKind == JsonValueKind.Object && (body.TryGetProperty("EventIds", out var a) || body.TryGetProperty("Ids", out a)) ? a : default;
                if (list.ValueKind == JsonValueKind.Array)
                    foreach (var v in list.EnumerateArray()) if (v.TryGetInt64(out long id)) ids.Add(id);
            }
            return Ok(PlayerEventDB.GetByIds(ids.Distinct().Take(MaxServed)).Select(Base));
        }

        [HttpGet("/api/playerevents/v1/{eventId:long}")]
        public IActionResult GetRecord(long eventId, [FromQuery] string? includeDetails = null)
        {
            var e = PlayerEventDB.Get(eventId);
            if (e == null) return NotFound();
            var record = Record(e);
            if (includeDetails is "true" or "True" or "1")
                record["tags"] = e.Tags.Select(t => new { tag = t, type = 0 });
            return Ok(record);
        }

        [HttpGet("/api/playerevents/v2/{eventId:long}")]
        public IActionResult GetEnvelope(long eventId)
        {
            var e = PlayerEventDB.Get(eventId);
            return e == null ? NotFound() : Ok(Envelope(e));
        }

        [HttpGet("/api/playerevents/v1/{eventId:long}/responses")]
        public IActionResult Responses(long eventId) =>
            Ok(PlayerEventDB.GetResponses(eventId).OrderBy(r => r.CreatedAt).Select(ResponseDto));

        // ---------- writes ----------

        [HttpPost("/api/playerevents/v2")]
        public async Task<IActionResult> Create()
        {
            long? me = AuthStuff.GetPlayerId(Request);
            if (me == null) return Unauthorized();
            var e = new PlayerEventDB.PlayerEvent { CreatorAccountId = me.Value, StartsAt = DateTime.UtcNow };
            string? error = Apply(e, await JsonBody());
            if (error != null) return BadRequest(new { error });
            if (string.IsNullOrWhiteSpace(e.Name)) e.Name = "Untitled Event";
            e.EndsAt ??= e.StartsAt + DefaultDuration;
            PlayerEventDB.Create(e);
            PlayerEventDB.SetResponse(e.EventId, me.Value, "Going");
            return Ok(Envelope(e));
        }

        [HttpPost("/api/playerevents/v2/{eventId:long}")]
        public async Task<IActionResult> Update(long eventId)
        {
            long? me = AuthStuff.GetPlayerId(Request);
            if (me == null) return Unauthorized();
            var e = PlayerEventDB.Get(eventId);
            if (e == null) return NotFound();
            if (!CanManage(e, me.Value)) return StatusCode(403);
            string? error = Apply(e, await JsonBody());
            if (error != null) return BadRequest(new { error });
            PlayerEventDB.Update(e);
            return Ok(Envelope(e));
        }

        [HttpPost("/api/playerevents/v2/delete/{eventId:long}")]
        [HttpDelete("/api/playerevents/v2/delete/{eventId:long}")]
        public IActionResult Delete(long eventId)
        {
            long? me = AuthStuff.GetPlayerId(Request);
            if (me == null) return Unauthorized();
            var e = PlayerEventDB.Get(eventId);
            if (e == null) return NotFound();
            if (!CanManage(e, me.Value)) return StatusCode(403);
            PlayerEventDB.Delete(eventId);
            return Ok(new { PlayerEvent = (object?)null, Result = 0, TagModifyResult = (object?)null });
        }

        private async Task<IActionResult> Edit(long eventId, Func<PlayerEventDB.PlayerEvent, Task<string?>> apply)
        {
            long? me = AuthStuff.GetPlayerId(Request);
            if (me == null) return Unauthorized();
            var e = PlayerEventDB.Get(eventId);
            if (e == null) return NotFound();
            if (!CanManage(e, me.Value)) return StatusCode(403);
            string? error = await apply(e) ?? Validate(e);
            if (error != null) return BadRequest(new { error });
            PlayerEventDB.Update(e);
            return Ok(Envelope(e));
        }

        [HttpPut("/api/playerevents/v2/{eventId:long}/name")]
        public Task<IActionResult> EditName(long eventId) => Edit(eventId, async e =>
        {
            string name = (await Field("name"))?.Trim() ?? string.Empty;
            if (name.Length == 0) return "Event names can't be empty.";
            e.Name = name;
            return null;
        });

        [HttpPut("/api/playerevents/v2/{eventId:long}/description")]
        public Task<IActionResult> EditDescription(long eventId) => Edit(eventId, async e =>
        {
            e.Description = await Field("description") ?? string.Empty;
            return null;
        });

        [HttpPut("/api/playerevents/v2/{eventId:long}/accessibility")]
        public Task<IActionResult> EditAccessibility(long eventId) => Edit(eventId, async e =>
        {
            string? raw = await Field("accessibility");
            int value = int.TryParse(raw, out int n) ? n : Array.FindIndex(AccessibilityNames, a => a.Equals(raw, StringComparison.OrdinalIgnoreCase));
            if (value is < 0 or > 2) return "Unknown accessibility.";
            e.Accessibility = AccessibilityNames[value];
            return null;
        });

        [HttpPut("/api/playerevents/v2/{eventId:long}/time")]
        public Task<IActionResult> EditTime(long eventId) => Edit(eventId, async e =>
        {
            var form = Request.HasFormContentType ? await Request.ReadFormAsync() : null;
            string? start = form?["startTime"].FirstOrDefault() ?? form?["StartTime"].FirstOrDefault();
            string? end = form?["endTime"].FirstOrDefault() ?? form?["EndTime"].FirstOrDefault();
            if (form == null)
            {
                var body = await JsonBody();
                if (body.ValueKind == JsonValueKind.Object)
                {
                    if (body.TryGetProperty("StartTime", out var s) || body.TryGetProperty("startTime", out s)) start = s.GetString();
                    if (body.TryGetProperty("EndTime", out var en) || body.TryGetProperty("endTime", out en)) end = en.GetString();
                }
            }
            if (start != null) { if (!TryTime(start, out var s)) return "Start time is not a date."; e.StartsAt = s; }
            if (end != null) { if (!TryTime(end, out var en)) return "End time is not a date."; e.EndsAt = en; }
            return null;
        });

        [HttpPut("/api/playerevents/v2/{eventId:long}/tags")]
        public Task<IActionResult> EditTags(long eventId) => Edit(eventId, async e =>
        {
            var body = await JsonBody();
            if (body.ValueKind == JsonValueKind.Object && (body.TryGetProperty("Tags", out var inner) || body.TryGetProperty("tags", out inner)))
                body = inner;
            if (body.ValueKind != JsonValueKind.Array) return "Expected a list of tags.";
            e.Tags = ParseTags(body);
            return null;
        });

        [HttpPost("/api/playerevents/v1/respond")]
        public async Task<IActionResult> Respond()
        {
            long? me = AuthStuff.GetPlayerId(Request);
            if (me == null) return Unauthorized();
            var body = await JsonBody();
            if (body.ValueKind != JsonValueKind.Object ||
                !body.TryGetProperty("PlayerEventId", out var idEl) || !idEl.TryGetInt64(out long eventId) ||
                !body.TryGetProperty("Type", out var typeEl) || !typeEl.TryGetInt32(out int type) || type is < 0 or > 2)
                return BadRequest();
            var e = PlayerEventDB.Get(eventId);
            if (e == null) return NotFound();
            PlayerEventDB.SetResponse(eventId, me.Value, ResponseNames[type]);
            return Ok(Envelope(e));
        }

        [HttpPost("/api/playerevents/v1/deleteResponse")]
        [HttpDelete("/api/playerevents/v1/deleteResponse")]
        public async Task<IActionResult> DeleteResponse()
        {
            long? me = AuthStuff.GetPlayerId(Request);
            if (me == null) return Unauthorized();
            var body = await JsonBody();
            if (body.ValueKind == JsonValueKind.Object &&
                (body.TryGetProperty("PlayerEventId", out var idEl) || body.TryGetProperty("EventId", out idEl)) &&
                idEl.TryGetInt64(out long eventId))
                PlayerEventDB.DeleteResponse(eventId, me.Value);
            return Ok(new { success = true });
        }

        [HttpPost("/api/playerevents/v1/bulkInvite")]
        public async Task<IActionResult> BulkInvite()
        {
            long? me = AuthStuff.GetPlayerId(Request);
            if (me == null) return Unauthorized();
            var body = await JsonBody();
            if (body.ValueKind != JsonValueKind.Object ||
                !body.TryGetProperty("PlayerEventId", out var idEl) || !idEl.TryGetInt64(out long eventId) ||
                !body.TryGetProperty("InvitedPlayerIds", out var list) || list.ValueKind != JsonValueKind.Array)
                return BadRequest();
            var e = PlayerEventDB.Get(eventId);
            if (e == null) return NotFound();
            if (!CanManage(e, me.Value) && PlayerEventDB.GetResponse(eventId, me.Value) == null) return StatusCode(403);
            foreach (var v in list.EnumerateArray().Take(200))
                if (v.TryGetInt64(out long target) && target != me.Value && PlayerEventDB.GetResponse(eventId, target) == null)
                    PlayerEventDB.SetResponse(eventId, target, "Pending");
            return Ok(Envelope(e));
        }

        [HttpPost("/api/playerevents/v1/report")]
        public async Task<IActionResult> Report()
        {
            long? me = AuthStuff.GetPlayerId(Request);
            if (me == null) return Unauthorized();
            var body = await JsonBody();
            if (body.ValueKind != JsonValueKind.Object || !body.TryGetProperty("PlayerEventId", out var idEl) || !idEl.TryGetInt64(out long eventId))
                return BadRequest(new { success = false, error = "PlayerEventId is required" });
            var e = PlayerEventDB.Get(eventId);
            if (e == null) return NotFound(new { success = false, error = "No such event" });
            string details = body.TryGetProperty("Details", out var d) && d.ValueKind == JsonValueKind.String ? d.GetString()! : "No details given.";
            DiscordLogger.LogReport($"Player event reported: \"{e.Name}\" (event {e.EventId}) by account {me.Value}: {details}");
            Console.WriteLine($"[EVENT REPORT] event={e.EventId} reporter={me.Value} details={details}");
            return Ok(new { success = true, error = string.Empty });
        }
    }
}
