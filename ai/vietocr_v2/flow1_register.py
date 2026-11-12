"""Flow 1 entry point for registering external and TRDG datasets."""

from .flow2_register import main, register_datasets

__all__ = ["main", "register_datasets"]

if __name__ == "__main__":
    main()
