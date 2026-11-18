using System;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace Mocha2023.Classes
{
    // The 2023 client only builds https RecNet requests, so a self-hosted server needs a certificate.
    public static class ReverieTls
    {
        public static X509Certificate2? Load()
        {
            string? path = Environment.GetEnvironmentVariable("REVERIE_TLS_CERT");
            if (string.IsNullOrWhiteSpace(path))
            {
                return null;
            }
            if (!File.Exists(path))
            {
                Create(path);
            }
            return new X509Certificate2(File.ReadAllBytes(path), (string?)null, X509KeyStorageFlags.Exportable);
        }

        private static void Create(string path)
        {
            using RSA rsa = RSA.Create(2048);
            var request = new CertificateRequest("CN=Reverie", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
            var names = new SubjectAlternativeNameBuilder();
            names.AddDnsName("localhost");
            names.AddIpAddress(IPAddress.Loopback);
            request.CertificateExtensions.Add(names.Build());
            request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection { new Oid("1.3.6.1.5.5.7.3.1") }, false));
            using X509Certificate2 cert = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddYears(10));
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
            File.WriteAllBytes(path, cert.Export(X509ContentType.Pfx));
            File.WriteAllText(Path.ChangeExtension(path, ".pem"), cert.ExportCertificatePem());
        }
    }
}
