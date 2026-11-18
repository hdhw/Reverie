using System;
using System.Collections.Generic;

namespace Mocha2023.Classes
{
    public class ServerConfig
    {
        public static object Bracket => new List<object>();

        public static string BaseURL = Setting("REVERIE_PUBLIC_URL", "http://localhost");
        public static readonly bool PublicUrlSet = Environment.GetEnvironmentVariable("REVERIE_PUBLIC_URL_SET") == "1";
        public static readonly string ServerName = Setting("REVERIE_SERVER_NAME", "Reverie");
            public static int GameVersion = 20230414;

        public static readonly string PhotonRealtimeAppId = Setting("PHOTON_REALTIME_APP_ID", "");
        public static readonly string PhotonVoiceAppId = Setting("PHOTON_VOICE_APP_ID", "");
        public static readonly string PhotonRegion = Setting("PHOTON_REGION", "us");
        public static readonly string PhotonAppVersion = Setting("PHOTON_APP_VERSION", "20230414_prod");

        private static string Setting(string name, string fallback) =>
            Program.LoadLocalSetting(name) is { Length: > 0 } value ? value : fallback;

        public static readonly string PhotonCustomAuthSecret =
        Program.LoadLocalSetting("PHOTON_CUSTOM_AUTH_SECRET");

        public static readonly string IpHashSecret =
        Program.LoadLocalSetting("IP_HASH_SECRET");

        public static bool PhotonEnabled =>
        !string.IsNullOrWhiteSpace(PhotonRealtimeAppId);

        public static readonly Version MinModVersion = new(1, 1, 0);
        public static readonly bool ExemptQuestFromModGate = true;
    }

    public static class AntiCheat
    {
        public static bool Enabled { get; set; } = true;

        public const string ValidationSecret =
        "8Kp2xQr9Zb4Vn8Mw3St5Uy1Io0Pp9Lk7Jn5Hg3Fd2Sa1Gh4Jf6Ds8Ad0Fg9Hj2Kl4";

        public const int MaxViolations = 3;
        public const string Action = "Kick";

        public static readonly List<string> TrustedHashes = new();
        public static readonly List<string> Blacklisted = new();
    }
}
