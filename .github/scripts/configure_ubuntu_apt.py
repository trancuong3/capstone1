"""Use direct, signed Ubuntu archives on disposable GitHub-hosted runners."""

from pathlib import Path
import re


SOURCE_URI = re.compile(
    r"(?<!\S)(?:mirror\+file:/etc/apt/apt-mirrors(?:-security)?\.txt"
    r"|https?://(?:azure\.archive|archive|security)\.ubuntu\.com/ubuntu/?)"
    r"(?=\s|$)"
)
ARCHIVE = "https://archive.ubuntu.com/ubuntu/"
SECURITY = "https://security.ubuntu.com/ubuntu/"
NETWORK_OPTIONS = (
    'Acquire::Retries "2";\n'
    'Acquire::http::Timeout "30";\n'
    'Acquire::https::Timeout "30";\n'
    'APT::Update::Error-Mode "any";\n'
)


def direct_archives(source: str) -> str:
    def replace(match: re.Match[str]) -> str:
        uri = match.group(0)
        return SECURITY if "security" in uri else ARCHIVE

    return SOURCE_URI.sub(replace, source)


def configure(apt_directory: Path) -> list[Path]:
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
        rewritten = direct_archives(original)
        if rewritten != original:
            updates.append((path, rewritten))

    if not recognized:
        raise RuntimeError("No supported Ubuntu archive source found; refusing to continue")

    for path, rewritten in updates:
        path.write_text(rewritten, encoding="utf-8")
    options = apt_directory / "apt.conf.d" / "99-viread-ci-network"
    options.parent.mkdir(parents=True, exist_ok=True)
    options.write_text(NETWORK_OPTIONS, encoding="utf-8")
    return [path for path, _ in updates]


if __name__ == "__main__":
    changed = configure(Path("/etc/apt"))
    print(f"Configured direct HTTPS Ubuntu archives; {len(changed)} source files updated")
    print("APT retries/timeouts are bounded; incomplete index updates remain fatal")
