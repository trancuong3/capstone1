"""Use direct, signed Ubuntu archives on disposable GitHub-hosted runners."""

from pathlib import Path
import re
from urllib.error import URLError
from urllib.request import urlopen


ARCHIVE = "https://archive.ubuntu.com/ubuntu/"
SECURITY = "https://security.ubuntu.com/ubuntu/"
# Registered Ubuntu archive mirrors; APT still verifies Ubuntu's signing key.
# https://launchpad.net/ubuntu/+archivemirrors
ARCHIVE_MIRRORS = (
    ARCHIVE,
    "https://mirrors.kernel.org/ubuntu/",
    "https://mirror.math.princeton.edu/pub/ubuntu/",
)
SOURCE_URI = re.compile(
    r"(?<!\S)(?:mirror\+file:/etc/apt/apt-mirrors(?:-security)?\.txt"
    r"|https?://(?:azure\.archive|archive|security)\.ubuntu\.com/ubuntu/?"
    + "".join("|" + re.escape(uri.rstrip("/")) + "/?" for uri in ARCHIVE_MIRRORS[1:])
    + r")(?=\s|$)"
)
NETWORK_OPTIONS = (
    'Acquire::Retries "2";\n'
    'Acquire::http::Timeout "30";\n'
    'Acquire::https::Timeout "30";\n'
    'APT::Update::Error-Mode "any";\n'
)


def probe_release(url: str) -> None:
    with urlopen(url, timeout=10) as response:
        if response.status != 200 or not response.geturl().startswith("https://"):
            raise ValueError("Archive probe did not return HTTPS success")
        prefix = response.read(8192)
        if not prefix.startswith(b"-----BEGIN PGP SIGNED MESSAGE-----") or b"Origin: Ubuntu" not in prefix:
            raise ValueError("Archive probe did not return Ubuntu InRelease metadata")


def select_archive(codename: str, probe=probe_release) -> str:
    if not re.fullmatch(r"[a-z][a-z0-9]*", codename):
        raise ValueError("Invalid Ubuntu codename")
    for archive in ARCHIVE_MIRRORS:
        try:
            for suite in (codename, f"{codename}-updates", f"{codename}-backports", f"{codename}-security"):
                probe(f"{archive}dists/{suite}/InRelease")
        except (OSError, URLError, ValueError) as error:
            print(f"Ubuntu archive unavailable: {archive} ({type(error).__name__})", flush=True)
            continue
        print(f"Selected Ubuntu archive: {archive}", flush=True)
        return archive
    raise RuntimeError("No Ubuntu archive passed HTTPS checks for all required suites")


def direct_archives(source: str, archive: str = ARCHIVE, security: str = SECURITY) -> str:
    def replace(match: re.Match[str]) -> str:
        uri = match.group(0)
        return security if "security" in uri else archive

    return SOURCE_URI.sub(replace, source)


def configure(apt_directory: Path, archive: str = ARCHIVE) -> list[Path]:
    if archive not in ARCHIVE_MIRRORS:
        raise ValueError("Archive must be an approved HTTPS Ubuntu mirror")
    sources = [apt_directory / "sources.list"]
    source_directory = apt_directory / "sources.list.d"
    if source_directory.is_dir():
        sources.extend(sorted(source_directory.glob("*.list")))
        sources.extend(sorted(source_directory.glob("*.sources")))

    updates = []
    recognized = False
    for path in sources:
        if not path.is_file():
            continue
        original = path.read_text(encoding="utf-8")
        recognized = recognized or SOURCE_URI.search(original) is not None
        rewritten = direct_archives(original, archive, archive)
        if rewritten != original:
            updates.append((path, rewritten))

    if not recognized:
        raise RuntimeError("No supported Ubuntu archive source found; refusing to continue")

    for path, rewritten in updates:
        path.write_text(rewritten, encoding="utf-8")
    # Keep the mirror-list path safe too if a runner tool restores its source URI.
    for filename in ("apt-mirrors.txt", "apt-mirrors-security.txt"):
        mirror_list = apt_directory / filename
        if mirror_list.is_file():
            mirror_list.write_text(archive + "\n", encoding="utf-8")
    options = apt_directory / "apt.conf.d" / "99-viread-ci-network"
    options.parent.mkdir(parents=True, exist_ok=True)
    options.write_text(NETWORK_OPTIONS, encoding="utf-8")
    return [path for path, _ in updates]


if __name__ == "__main__":
    release = dict(
        line.split("=", 1)
        for line in Path("/etc/os-release").read_text(encoding="utf-8").splitlines()
        if "=" in line
    )
    if release.get("ID", "").strip('"') != "ubuntu":
        raise RuntimeError("This CI helper requires an Ubuntu runner")
    archive = select_archive(release["VERSION_CODENAME"].strip('"'))
    changed = configure(Path("/etc/apt"), archive)
    print(f"Configured direct HTTPS Ubuntu archives; {len(changed)} source files updated")
    print("APT retries/timeouts are bounded; incomplete index updates remain fatal")
