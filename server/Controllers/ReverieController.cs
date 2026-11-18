using System.Diagnostics;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Mvc;
using Mocha2023.Classes;
using Mocha2023.Classes.DBs;

namespace Mocha2023.Controllers
{
    // Read-only feed for the Reverie desktop app / web panel. Loopback only and keyed,
    // so a server exposed to the internet never serves it to players.
    [ApiController]
    [Route("reverie")]
    public class ReverieController : ControllerBase
    {
        private static readonly byte[] Key =
            Encoding.UTF8.GetBytes(Program.LoadLocalSetting("REVERIE_ADMIN_KEY"));

        private bool Allowed()
        {
            IPAddress? remote = HttpContext.Connection.RemoteIpAddress;
            if (Key.Length < 16 || remote == null || !IPAddress.IsLoopback(remote))
                return false;
            if (Request.Headers.ContainsKey("X-Forwarded-For") || Request.Headers.ContainsKey("CF-Connecting-IP"))
                return false;
            byte[] given = Encoding.UTF8.GetBytes(Request.Headers["X-Reverie-Key"].ToString());
            return CryptographicOperations.FixedTimeEquals(given, Key);
        }

        [HttpGet("status")]
        public IActionResult Status()
        {
            if (!Allowed())
                return NotFound();

            var online = NotiController.OnlinePlayerIds.ToHashSet();
            return Ok(new
            {
                startedAt = Process.GetCurrentProcess().StartTime.ToUniversalTime(),
                gameVersion = ServerConfig.GameVersion,
                photonConfigured = ServerConfig.PhotonEnabled,
                players = PlayerDB.Players.LongCount(),
                online = online.Count,
                rooms = RoomDB.Rooms.LongCount()
            });
        }

        [HttpGet("players")]
        public IActionResult Players([FromQuery] string? q, [FromQuery] int limit = 100)
        {
            if (!Allowed())
                return NotFound();

            var online = NotiController.OnlinePlayerIds.ToHashSet();
            string query = (q ?? "").Trim();
            var rows = PlayerDB.Players.FindAll()
                .Where(p => query.Length == 0 ||
                            p.PlayerId.ToString() == query ||
                            (p.Player?.Username ?? "").Contains(query, StringComparison.OrdinalIgnoreCase) ||
                            (p.Player?.DisplayName ?? "").Contains(query, StringComparison.OrdinalIgnoreCase))
                .OrderByDescending(p => online.Contains(p.PlayerId))
                .ThenByDescending(p => p.Player?.LastLoginAt)
                .Take(Math.Clamp(limit, 1, 500))
                .Select(p => new
                {
                    id = p.PlayerId,
                    username = p.Player?.Username,
                    displayName = p.Player?.DisplayName,
                    level = p.Player?.Level,
                    createdAt = p.Player?.CreatedAt,
                    lastLoginAt = p.Player?.LastLoginAt,
                    online = online.Contains(p.PlayerId),
                    banned = PlayerDB.IsPlayerBanned(p.PlayerId, out _),
                    loginDisabled = p.LoginDisabled
                });
            return Ok(rows);
        }
    }
}
