"""Flow 1 entry point for real-image DBNet line crop and label matching."""

from .flow2_prepare import main, match_external_annotations

__all__ = ["main", "match_external_annotations"]

if __name__ == "__main__":
    main()
