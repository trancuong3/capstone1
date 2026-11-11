"""Local regression coverage; never accesses the host's APT or network."""

from pathlib import Path
import tempfile
import unittest

from configure_ubuntu_apt import ARCHIVE, NETWORK_OPTIONS, SECURITY, configure, direct_archives


class ConfigureUbuntuAptTests(unittest.TestCase):
    def test_runner_mirrorlist_uses_direct_archive_without_losing_trust_or_suites(self):
        original = (
            "Types: deb\n"
            "URIs: mirror+file:/etc/apt/apt-mirrors.txt\n"
            "Suites: noble noble-updates noble-backports noble-security\n"
            "Components: main restricted universe multiverse\n"
            "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n"
        )
        expected = original.replace("mirror+file:/etc/apt/apt-mirrors.txt", ARCHIVE)
        self.assertEqual(direct_archives(original), expected)
        self.assertNotIn("mirror+file:", direct_archives(original))

    def test_direct_azure_source_is_replaced_in_legacy_list(self):
        original = (
            "deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] "
            "http://azure.archive.ubuntu.com/ubuntu noble universe\n"
        )
        self.assertEqual(
            direct_archives(original),
            original.replace("http://azure.archive.ubuntu.com/ubuntu", ARCHIVE),
        )

    def test_security_sources_keep_security_archive(self):
        for uri in (
            "mirror+file:/etc/apt/apt-mirrors-security.txt",
            "http://security.ubuntu.com/ubuntu",
            "https://security.ubuntu.com/ubuntu/",
        ):
            with self.subTest(uri=uri):
                self.assertEqual(direct_archives(f"URIs: {uri}\n"), f"URIs: {SECURITY}\n")

    def test_unrelated_and_similarly_named_repositories_are_unchanged(self):
        original = (
            "deb https://packages.microsoft.com/ubuntu/24.04/prod noble main\n"
            "deb https://archive.ubuntu.com/ubuntu-extra noble main\n"
            "# Existing comments and repository options remain intact.\n"
        )
        self.assertEqual(direct_archives(original), original)

    def test_configuration_handles_both_formats_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            sources = root / "sources.list.d"
            sources.mkdir()
            legacy = root / "sources.list"
            legacy.write_text("deb http://azure.archive.ubuntu.com/ubuntu/ noble main\n", encoding="utf-8")
            deb822 = sources / "ubuntu.sources"
            deb822.write_text("URIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: noble\n", encoding="utf-8")
            third_party = sources / "microsoft.list"
            third_party.write_text("deb https://packages.microsoft.com/ubuntu/24.04/prod noble main\n", encoding="utf-8")
            original_third_party = third_party.read_bytes()

            self.assertEqual(set(configure(root)), {legacy, deb822})
            self.assertIn(ARCHIVE, legacy.read_text(encoding="utf-8"))
            self.assertIn(ARCHIVE, deb822.read_text(encoding="utf-8"))
            self.assertEqual(third_party.read_bytes(), original_third_party)
            options = root / "apt.conf.d" / "99-viread-ci-network"
            self.assertEqual(options.read_text(encoding="utf-8"), NETWORK_OPTIONS)
            self.assertIn('APT::Update::Error-Mode "any";', options.read_text(encoding="utf-8"))
            self.assertEqual(configure(root), [])

    def test_unknown_sources_fail_before_creating_options(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with self.assertRaisesRegex(RuntimeError, "No supported Ubuntu"):
                configure(root)
            self.assertFalse((root / "apt.conf.d").exists())


if __name__ == "__main__":
    unittest.main()
