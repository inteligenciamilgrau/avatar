using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Speech.AudioFormat;
using System.Speech.Synthesis;
using System.Text;

namespace AvatarTts
{
    public static class Program
    {
        public static int Main(string[] args)
        {
            Console.OutputEncoding = new UTF8Encoding(false);
            try
            {
                if (args.Length == 0 || args[0] == "list" || args[0] == "--list")
                    return ListVoices();
                if (args[0] == "speak")
                    return Speak(args);
                Console.WriteLine("{\"ok\":false,\"error\":\"uso: TtsTool list | speak --voice NOME --rate N --volume N --out wav --text arquivo.txt\"}");
                return 2;
            }
            catch (Exception ex)
            {
                Console.WriteLine("{\"ok\":false,\"error\":\"" + JsonEscape(ex.Message) + "\"}");
                return 1;
            }
        }

        static int ListVoices()
        {
            var sb = new StringBuilder();
            sb.Append("{\"ok\":true,\"voices\":[");
            using (var synth = new SpeechSynthesizer())
            {
                bool first = true;
                foreach (InstalledVoice v in synth.GetInstalledVoices())
                {
                    if (!v.Enabled) continue;
                    var info = v.VoiceInfo;
                    if (!first) sb.Append(",");
                    first = false;
                    sb.Append("{\"name\":\"").Append(JsonEscape(info.Name)).Append("\",");
                    sb.Append("\"culture\":\"").Append(JsonEscape(info.Culture.Name)).Append("\",");
                    sb.Append("\"gender\":\"").Append(info.Gender).Append("\",");
                    sb.Append("\"age\":\"").Append(info.Age).Append("\",");
                    sb.Append("\"description\":\"").Append(JsonEscape(info.Description)).Append("\"}");
                }
            }
            sb.Append("]}");
            Console.WriteLine(sb.ToString());
            return 0;
        }

        static int Speak(string[] args)
        {
            var opt = Parse(args);
            string voice = Get(opt, "voice", "");
            int rate = ParseInt(Get(opt, "rate", "0"), 0, -10, 10);
            int volume = ParseInt(Get(opt, "volume", "100"), 100, 0, 100);
            string outPath = Get(opt, "out", "");
            string textPath = Get(opt, "text", "");

            if (string.IsNullOrWhiteSpace(outPath) || string.IsNullOrWhiteSpace(textPath))
            {
                Console.WriteLine("{\"ok\":false,\"error\":\"faltam --out ou --text\"}");
                return 2;
            }

            string text = File.ReadAllText(textPath, Encoding.UTF8).Trim();
            if (text.Length == 0)
            {
                Console.WriteLine("{\"ok\":false,\"error\":\"texto vazio\"}");
                return 2;
            }
            if (text.Length > 4000)
                text = text.Substring(0, 4000);

            var visemes = new List<string>();
            var words = new List<string>();

            using (var synth = new SpeechSynthesizer())
            {
                if (!string.IsNullOrWhiteSpace(voice))
                {
                    bool found = false;
                    foreach (InstalledVoice v in synth.GetInstalledVoices())
                    {
                        if (string.Equals(v.VoiceInfo.Name, voice, StringComparison.OrdinalIgnoreCase))
                        {
                            synth.SelectVoice(v.VoiceInfo.Name);
                            found = true;
                            break;
                        }
                    }
                    if (!found)
                    {
                        Console.WriteLine("{\"ok\":false,\"error\":\"voz nao encontrada: " + JsonEscape(voice) + "\"}");
                        return 3;
                    }
                }
                else
                {
                    var pt = synth.GetInstalledVoices(new CultureInfo("pt-BR"));
                    if (pt.Count > 0)
                        synth.SelectVoice(pt[0].VoiceInfo.Name);
                }

                synth.Rate = rate;
                synth.Volume = volume;

                synth.VisemeReached += (s, e) =>
                {
                    visemes.Add(string.Format(
                        CultureInfo.InvariantCulture,
                        "{{\"t\":{0:0.###},\"id\":{1}}}",
                        e.AudioPosition.TotalMilliseconds,
                        e.Viseme));
                };

                synth.SpeakProgress += (s, e) =>
                {
                    words.Add(string.Format(
                        CultureInfo.InvariantCulture,
                        "{{\"t\":{0:0.###},\"text\":\"{1}\",\"start\":{2},\"len\":{3}}}",
                        e.AudioPosition.TotalMilliseconds,
                        JsonEscape(e.Text),
                        e.CharacterPosition,
                        e.CharacterCount));
                };

                var dir = Path.GetDirectoryName(outPath);
                if (!string.IsNullOrEmpty(dir))
                    Directory.CreateDirectory(dir);

                synth.SetOutputToWaveFile(
                    outPath,
                    new SpeechAudioFormatInfo(22050, AudioBitsPerSample.Sixteen, AudioChannel.Mono));
                synth.Speak(text);
                synth.SetOutputToNull();
            }

            double duration = WavDurationMs(outPath);
            var json = new StringBuilder();
            json.Append("{\"ok\":true,");
            json.Append("\"voice\":\"").Append(JsonEscape(voice)).Append("\",");
            json.Append(string.Format(CultureInfo.InvariantCulture, "\"durationMs\":{0:0.###},", duration));
            json.Append("\"visemes\":[").Append(string.Join(",", visemes.ToArray())).Append("],");
            json.Append("\"words\":[").Append(string.Join(",", words.ToArray())).Append("]}");
            Console.WriteLine(json.ToString());
            return 0;
        }

        static Dictionary<string, string> Parse(string[] args)
        {
            var d = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (int i = 1; i < args.Length; i++)
            {
                string a = args[i];
                if (a.StartsWith("--") && i + 1 < args.Length)
                    d[a.Substring(2)] = args[++i];
            }
            return d;
        }

        static string Get(Dictionary<string, string> d, string key, string fallback)
        {
            string v;
            return d.TryGetValue(key, out v) ? v : fallback;
        }

        static int ParseInt(string s, int fallback, int min, int max)
        {
            int n;
            if (!int.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out n))
                n = fallback;
            if (n < min) n = min;
            if (n > max) n = max;
            return n;
        }

        static double WavDurationMs(string path)
        {
            using (var fs = File.OpenRead(path))
            using (var br = new BinaryReader(fs))
            {
                if (Encoding.ASCII.GetString(br.ReadBytes(4)) != "RIFF") return 0;
                br.ReadInt32();
                if (Encoding.ASCII.GetString(br.ReadBytes(4)) != "WAVE") return 0;
                int byteRate = 0;
                int dataSize = 0;
                while (fs.Position < fs.Length - 8)
                {
                    string id = Encoding.ASCII.GetString(br.ReadBytes(4));
                    int size = br.ReadInt32();
                    long next = fs.Position + size;
                    if (id == "fmt ")
                    {
                        br.ReadInt16();
                        br.ReadInt16();
                        br.ReadInt32();
                        byteRate = br.ReadInt32();
                    }
                    else if (id == "data")
                    {
                        dataSize = size;
                        break;
                    }
                    if (next + (size % 2) > fs.Length) break;
                    fs.Position = next + (size % 2);
                }
                if (byteRate > 0) return 1000.0 * dataSize / byteRate;
                return 0;
            }
        }

        static string JsonEscape(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            var sb = new StringBuilder();
            foreach (char c in s)
            {
                switch (c)
                {
                    case '\\': sb.Append("\\\\"); break;
                    case '"': sb.Append("\\\""); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 32) sb.AppendFormat("\\u{0:x4}", (int)c);
                        else sb.Append(c);
                        break;
                }
            }
            return sb.ToString();
        }
    }
}
