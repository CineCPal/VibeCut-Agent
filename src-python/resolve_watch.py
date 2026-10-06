"""Entry point for ``resolve-watch`` under DaVinci Resolve's own Python (see Launch::for_resolve).

ResolvePython runs isolated (``-I``): it ignores PYTHONPATH and doesn't put a script's own folder on
``sys.path``, so ``python -m vibecut_agent`` can't find the package. This file sits next to the
package and adds its folder itself.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Imported only after the path above is set up.
from vibecut_agent.headless import main

sys.exit(main(["resolve-watch"]))
