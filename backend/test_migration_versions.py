"""Keep Supabase migration identifiers unambiguous before deployment."""

from collections import defaultdict
from datetime import datetime
from pathlib import Path
import unittest


MIGRATIONS = Path(__file__).resolve().parents[1] / "supabase" / "migrations"


class MigrationVersionTests(unittest.TestCase):
    def test_migration_filenames_have_valid_timestamps(self):
        migrations = sorted(MIGRATIONS.glob("*.sql"))
        self.assertTrue(migrations, "No Supabase migrations found")
        for migration in migrations:
            with self.subTest(migration=migration.name):
                self.assertRegex(migration.name, r"^\d{14}_[a-z0-9_]+\.sql$")
                datetime.strptime(migration.name[:14], "%Y%m%d%H%M%S")

    def test_migration_versions_are_unique(self):
        by_version = defaultdict(list)
        for migration in sorted(MIGRATIONS.glob("*.sql")):
            by_version[migration.name.split("_", 1)[0]].append(migration.name)
        duplicates = {
            version: names for version, names in by_version.items() if len(names) > 1
        }
        self.assertEqual(
            duplicates,
            {},
            "Supabase identifies migrations by timestamp, not the full filename: "
            f"{duplicates}",
        )


if __name__ == "__main__":
    unittest.main()
