using System;
using System.IO;
using System.Text.RegularExpressions;
using Xunit;

namespace MorpheusOracle.Contracts.Tests
{
    internal static class ContractSourceAssertions
    {
        public static string FindRepoRoot()
        {
            string[] startingPoints =
            {
                Directory.GetCurrentDirectory(),
                AppContext.BaseDirectory
            };

            foreach (string startingPoint in startingPoints)
            {
                string? root = TryFindRepoRoot(startingPoint);
                if (root != null)
                {
                    return root;
                }
            }

            throw new DirectoryNotFoundException("Could not locate repository root containing contracts/");
        }

        public static string ResolveRelativeSource(params string[] relativeSegments)
        {
            string path = FindRepoRoot();
            foreach (string segment in relativeSegments)
            {
                path = Path.Combine(path, segment);
            }

            if (!File.Exists(path))
            {
                throw new FileNotFoundException($"Expected source file was not found: {path}");
            }

            return path;
        }

        public static string ReadSource(params string[] relativeSegments)
        {
            return NormalizeNewlines(File.ReadAllText(ResolveRelativeSource(relativeSegments)));
        }

        public static string ReadSourcesInDirectory(params string[] relativeSegments)
        {
            return ReadSourcesByPattern("*.cs", relativeSegments);
        }

        public static string ReadSourcesByPattern(string searchPattern, params string[] relativeSegments)
        {
            string path = FindRepoRoot();
            foreach (string segment in relativeSegments)
            {
                path = Path.Combine(path, segment);
            }

            if (!Directory.Exists(path))
            {
                throw new DirectoryNotFoundException($"Expected source directory was not found: {path}");
            }

            return string.Join(
                "\n",
                Directory
                    .GetFiles(path, searchPattern, SearchOption.TopDirectoryOnly)
                    .OrderBy(file => file, StringComparer.Ordinal)
                    .Select(file => NormalizeNewlines(File.ReadAllText(file))));
        }

        /// <summary>
        /// Source-shape assertions embed <c>\n</c> and exact indentation in their
        /// expected literals. The working tree is CRLF on Windows (core.autocrlf)
        /// and LF on the CI runner, so raw file text would make those assertions
        /// platform-dependent. Line endings carry no meaning for the invariants
        /// under test, so collapse them to LF before any comparison.
        /// </summary>
        private static string NormalizeNewlines(string text)
        {
            if (text.IndexOf('\r') < 0)
            {
                return text;
            }

            return text.Replace("\r\n", "\n").Replace("\r", "\n");
        }

        /// <summary>
        /// Per-file security-review budget, enforced as a ratchet.
        /// </summary>
        /// <param name="maxLines">Ceiling for any contract source file.</param>
        /// <param name="legacyDebt">
        /// Recorded over-budget files as <c>relative/path.cs=lines</c>. Each one may
        /// not grow past its recorded ceiling, no new offender may appear, and an
        /// entry whose file is back inside the budget must be deleted. Shrinking a
        /// still-over-budget file is deliberately tolerated: pinning the exact line
        /// count would tie this gate to whatever else is uncommitted, so a commit
        /// carrying only the test could go red for work nobody is doing.
        /// </param>
        /// <remarks>
        /// A reviewer can only reason about a contract they can hold in view at
        /// once, and the files this guards are the ones that move user funds. The
        /// budget used to be asserted only in neo-os-contracts - the tidiest repo -
        /// while larger fund-holding contracts elsewhere carried no gate at all.
        /// It lives here so all four contract estates enforce one implementation.
        /// </remarks>
        public static void AssertContractFilesStayReviewable(int maxLines, params string[] legacyDebt)
        {
            string repoRoot = FindRepoRoot();
            string contractsRoot = Path.Combine(repoRoot, "contracts");

            Dictionary<string, int> debt = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (string entry in legacyDebt)
            {
                int split = entry.LastIndexOf('=');
                if (split <= 0)
                {
                    throw new ArgumentException($"Malformed legacy debt entry '{entry}'; expected path.cs=lines");
                }

                debt[entry.Substring(0, split)] = int.Parse(entry.Substring(split + 1));
            }

            List<string> failures = new List<string>();
            foreach (string path in Directory.GetFiles(contractsRoot, "*.cs", SearchOption.AllDirectories))
            {
                if (path.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal) ||
                    path.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal) ||
                    path.Contains($"{Path.DirectorySeparatorChar}__tests__{Path.DirectorySeparatorChar}", StringComparison.Ordinal) ||
                    path.EndsWith(".artifacts.cs", StringComparison.Ordinal))
                {
                    // bin/obj and *.artifacts.cs are compiler output: nobody reviews
                    // them line by line, so a review budget does not apply to them.
                    continue;
                }

                // '/' on every platform so recorded debt strings survive a Windows
                // checkout of a repo whose CI runner is ubuntu.
                string relative = Path.GetRelativePath(repoRoot, path).Replace('\\', '/');
                int lines = File.ReadLines(path).Count();

                if (lines <= maxLines)
                {
                    // Only report a recorded entry that is no longer needed at all.
                    // A file that merely shrank while still over budget is not an
                    // error: pinning the exact line count would tie this gate to
                    // whatever else is in flight, so a commit of the test alone
                    // would go red for reasons nobody is working on.
                    if (debt.ContainsKey(relative))
                    {
                        failures.Add(
                            $"{relative} is now {lines} lines, inside the {maxLines}-line budget; " +
                            "its debt entry is paid off - delete it");
                    }

                    continue;
                }

                if (debt.TryGetValue(relative, out int ceiling))
                {
                    if (lines > ceiling)
                    {
                        failures.Add(
                            $"{relative} grew to {lines} lines, past its recorded ceiling of {ceiling}. " +
                            "Split the partial instead of raising the number.");
                    }
                }
                else
                {
                    failures.Add(
                        $"{relative} ({lines} lines) exceeds the {maxLines}-line review budget; " +
                        "split it into another partial so each piece stays reviewable");
                }
            }

            Assert.True(
                failures.Count == 0,
                "Contract source files should stay small enough for security review. " +
                string.Join("; ", failures.Order(StringComparer.Ordinal)));
        }

        public static void AssertHasPublicClass(string code, string className)
        {
            AssertContainsDeclaration(
                code,
                $@"^\s*public\s+(?:partial\s+)?class\s+{Regex.Escape(className)}\b",
                $"Expected public class '{className}' was not found.");
        }

        public static void AssertHasPublicStruct(string code, string structName)
        {
            AssertContainsDeclaration(
                code,
                $@"^\s*public\s+struct\s+{Regex.Escape(structName)}\b",
                $"Expected public struct '{structName}' was not found.");
        }

        public static void AssertHasPublicStaticMethod(string code, string returnType, string methodName)
        {
            AssertContainsDeclaration(
                code,
                $@"^\s*public\s+static\s+{ToTypePattern(returnType)}\s+{Regex.Escape(methodName)}\s*\(",
                $"Expected public static method '{returnType} {methodName}(...)' was not found.");
        }

        public static void AssertHasPublicField(string code, string typeName, string fieldName)
        {
            AssertContainsDeclaration(
                code,
                $@"^\s*public\s+{ToTypePattern(typeName)}\s+{Regex.Escape(fieldName)}\s*;",
                $"Expected public field '{typeName} {fieldName};' was not found.");
        }

        private static void AssertContainsDeclaration(string code, string pattern, string message)
        {
            string strippedCode = StripComments(code);
            bool matched = Regex.IsMatch(strippedCode, pattern, RegexOptions.Multiline | RegexOptions.CultureInvariant);
            Assert.True(matched, message);
        }

        private static string? TryFindRepoRoot(string startingPoint)
        {
            string current = Path.GetFullPath(startingPoint);
            for (int i = 0; i < 16; i++)
            {
                if (Directory.Exists(Path.Combine(current, "contracts")))
                {
                    return current;
                }

                DirectoryInfo? parent = Directory.GetParent(current);
                if (parent == null)
                {
                    return null;
                }

                current = parent.FullName;
            }

            return null;
        }

        private static string StripComments(string code)
        {
            string withoutBlockComments = Regex.Replace(code, @"/\*.*?\*/", string.Empty, RegexOptions.Singleline);
            return Regex.Replace(withoutBlockComments, @"//.*$", string.Empty, RegexOptions.Multiline);
        }

        private static string ToTypePattern(string typeName)
        {
            return Regex.Escape(typeName).Replace(@"\ ", @"\s+");
        }
    }
}
