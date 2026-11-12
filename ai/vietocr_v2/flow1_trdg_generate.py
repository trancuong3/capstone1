"""Flow 1 entry point for generating synthetic OCR crops with TRDG."""

from .trdg_generate import generate_trdg, main

__all__ = ["generate_trdg", "main"]

if __name__ == "__main__":
    main()
