"""可开关插件。内核（tokenize / L0 / L2 / 阅读）不依赖这里。

清退一个功能：实验室关掉，或删除对应 `plugins/<id>.py` + `web/plugins/<id>.js`，
再从 `catalog.PLUGINS` 去掉那一行。
"""

from wise_reader.plugins.catalog import PLUGINS, PluginSpec
from wise_reader.plugins.runtime import PluginContext, mount_plugins

__all__ = ["PLUGINS", "PluginSpec", "PluginContext", "mount_plugins"]
