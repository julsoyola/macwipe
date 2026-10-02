import sys

if sys.version_info < (3, 9):
    raise SystemExit("mac-scrubber requires Python 3.9 or newer; macOS does not include a supported Python by default.")

from .cli import main

raise SystemExit(main())
