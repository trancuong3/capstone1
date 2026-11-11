"""Local regression coverage; never accesses the host's APT or network."""

from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import URLError

from configure_ubuntu_apt import (
    ARCHIVE, ARCHIVE_MIRRORS, NETWORK_OPTIONS, SECURITY,
    configure, direct_archives, probe_release, select_archive,
)


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

    def test_primary_dns_failure_selects_fallback_only_after_all_suites_pass(self):
        seen = []
        def probe(url):
            seen.append(url)
            if url.startswith(ARCHIVE):
                raise URLError("Temporary failure resolving archive.ubuntu.com")
        selected = select_archive("noble", probe)
        self.assertEqual(selected, ARCHIVE_MIRRORS[1])
        self.assertEqual(seen, [ARCHIVE + "dists/noble/InRelease"] + [
            selected + f"dists/{suite}/InRelease"
            for suite in ("noble", "noble-updates", "noble-backports", "noble-security")
        ])

    def test_missing_security_pocket_rejects_otherwise_available_archive(self):
        def probe(url):
            if url == ARCHIVE + "dists/noble-security/InRelease":
                raise URLError("missing security metadata")
        self.assertEqual(select_archive("noble", probe), ARCHIVE_MIRRORS[1])

    def test_all_unreachable_archives_fail_without_choosing_an_unchecked_source(self):
        def probe(url):
            raise URLError("DNS unavailable")
        with self.assertRaisesRegex(RuntimeError, "No Ubuntu archive"):
            select_archive("noble", probe)

    def test_reachable_primary_is_kept(self):
        probe = MagicMock()
        self.assertEqual(select_archive("noble", probe), ARCHIVE)
        self.assertEqual(probe.call_count, 4)

    def test_probe_rejects_html_or_https_downgrade_and_accepts_release_metadata(self):
        payload = b"-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA512\n\nOrigin: Ubuntu\n"
        for final_url, content, valid in (
            (ARCHIVE, b"<html>service unavailable</html>", False),
            ("http://archive.ubuntu.com/ubuntu/", payload, False),
            (ARCHIVE, payload, True),
        ):
            with self.subTest(final_url=final_url, valid=valid):
                response = MagicMock()
                response.status = 200
                response.geturl.return_value = final_url
                response.read.return_value = content
                with patch("configure_ubuntu_apt.urlopen") as opener:
                    opener.return_value.__enter__.return_value = response
                    if valid:
                        probe_release(ARCHIVE + "dists/noble/InRelease")
                    else:
                        with self.assertRaises(ValueError):
                            probe_release(ARCHIVE + "dists/noble/InRelease")
                    opener.assert_called_once_with(ARCHIVE + "dists/noble/InRelease", timeout=10)

    def test_fallback_also_replaces_restored_mirror_lists_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "sources.list").write_text(
                "deb mirror+file:/etc/apt/apt-mirrors.txt noble main\n", encoding="utf-8",
            )
            mirror_list = root / "apt-mirrors.txt"
            mirror_list.write_text("http://azure.archive.ubuntu.com/ubuntu/ priority:1\n", encoding="utf-8")
            selected = ARCHIVE_MIRRORS[1]
            configure(root, selected)
            self.assertEqual(mirror_list.read_text(encoding="utf-8"), selected + "\n")
            self.assertIn(selected, (root / "sources.list").read_text(encoding="utf-8"))
            self.assertEqual(configure(root, selected), [])
            with self.assertRaisesRegex(ValueError, "approved HTTPS"):
                configure(root, "http://unapproved.example/ubuntu/")


if __name__ == "__main__":
    unittest.main()
