# 🦊 更新检查器(napcat-plugin-update-checker)

这是一个专为 [NapCat](https://github.com/NapNeko/NapCatQQ) 设计的更新检测与管理工具。
支持插件商店、自动更新、Git 仓库更新推送以及 WebUI 可视化管理。

内置插件源仓库：[HolyFoxTeam](https://github.com/HolyFoxTeam/napcat-plugin-community-index)

---

## ✨ 核心功能

- 🛡️ **智能检测**：自动对比本地插件与商店版本差异。
- 🌐 **多源支持**：支持社区源与自定义第三方插件源。
- ⏰ **定时巡检**：按间隔自动检查更新，支持群聊/私聊通知。
- 🚀 **镜像加速**：支持 Raw 索引与下载镜像测速和优选。
- 🔄 **自动更新**：支持 `仅通知` / `自动更新`，并提供白名单与忽略列表。
- 📊 **可视化面板**：内置 WebUI 仪表盘，支持配置管理与一键操作。
- 📦 **便捷安装**：支持在线安装商店插件，支持本地 ZIP/文件夹导入。
- 🧩 **Git 推送**：支持 GitHub/Gitee/Gitcode/Gitea/CNB 仓库 Commit/Release 更新推送。
- 🎨 **主题配置**：支持暖色/蓝色/绿色/紫色预设主题与自定义主题色。

---

## 🛠️ 安装指南

### 1. 手动安装（推荐）
1. 下载最新版本的 [Release](https://github.com/xiowo/napcat-plugin-update-checker/releases) 压缩包。
2. 解压到 NapCat 的 `plugins` 目录。
3. 重启 NapCat。


---

## 💬 群内命令

插件默认监听前缀为 `#更新插件`（可在配置中修改）

| 指令 | 说明 | 权限 |
| :--- | :--- | :--- |
| `#更新插件帮助` | 显示可用指令列表 | 仅主人 |
| `#更新插件状态` | 查看运行状态 | 仅主人 |
| `#更新插件检查` | 立即执行一次更新检测 | 仅主人 |
| `#更新插件全部` | 更新所有可更新插件 | 仅主人 |
| `#更新插件编号1` | 按编号更新指定插件 | 仅主人 |
| `#更新插件仓库检查` | 立即检查仓库更新并推送当前群 | 仅主人（仅群聊） |
| `#更新插件 version` | 查看插件版本 | 仅主人 |

> 权限规则：仅 `masterQQ` 中配置的 QQ 可执行管理命令（支持英文逗号分隔多个 QQ）。

---

## ⚙️ 配置说明

可在 WebUI 扩展页面中修改，核心配置项如下：

### 插件设置

| 配置项 | 默认值 | 描述 |
| :--- | :--- | :--- |
| `启用群命令` | `true` | 是否启用群内命令 |
| `命令前缀` | `#更新插件` | 命令前缀 |
| `主人QQ` | - | 设置主人QQ（多个用英文逗号分隔） |
| `无权限时静默` | `false` | 开启后，非主人用户执行管理命令时不回复权限提示 |

### 插件更新设置

| 配置项（WebUI） | 默认值 | 描述 |
| :--- | :--- | :--- |
| `更新模式` | `仅通知` | `仅通知` / `自动更新` |
| `启用定时检查` | `true` | 是否启用定时检查 |
| `检查间隔` | `30` | 检查间隔（分钟） |
| `通知群聊` | - | 通知群聊列表 |
| `通知用户` | - | 通知用户列表 |

### Git推送设置

| 配置项 | 默认值 | 描述 |
| :--- | :--- | :--- |
| `自动检查` | `true` | Git 推送定时检查 |
| `自动检查定时时间` | `30` | Git 检查间隔（分钟） |
| `推送类型` | `文本推送` | Git 推送渲染模式（`文本推送` / `渲染推送`） |

---

## 🧱 自建商店索引文件结构参考

插件会读取商店索引 JSON，推荐使用以下结构（`statsUrl` 可选）：

```json
{
  "plugins": [
    {
      "id": "example-plugin",
      "name": "示例插件",
      "version": "1.2.3",
      "downloadUrl": "https://github.com/owner/repo/releases/download/v1.2.3/example-plugin.zip",
      "description": "这是一个示例插件",
      "author": "作者名"
    }
  ],
  "statsUrl": "https://example.com/plugins.stats.json"
}
```

### 重要

- `statsUrl` **不是必须**，只是可选的外部增强数据引用。
- `plugins[]` 中可直接写用于更新判断的核心字段：`id + version + downloadUrl`。
- 若配置了 `statsUrl`，会按 `plugin.id` 合并，且 `statsUrl` 中同名字段优先级更高（覆盖主索引）。
- 当前实现里，`downloads / updateTime` 属于扩展统计字段，虽然可以直接放在plugins[] 中，但是仍建议放在 `statsUrl` 对应文件中。

### 顶层字段

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `plugins` | `array` | 是 | 插件列表 |
| `statsUrl` | `string` | 否 | 可选增强信息地址（支持相对路径，会基于当前索引 URL 解析） |

### `plugins[]` 字段

| 字段 | 类型 | 必填 | 说明 |
| :--- | :--- | :--- | :--- |
| `id` | `string` | 是 | 插件唯一标识（用于匹配已安装插件） |
| `name` | `string` | 否 | 插件显示名（缺省时回退为 `id`） |
| `version` | `string` | 是* | 插件版本（可被 `statsUrl` 同名项覆盖） |
| `downloadUrl` | `string` | 是* | 插件下载地址（可被 `statsUrl` 同名项覆盖） |
| `description` | `string` | 否 | 插件描述 |
| `author` | `string` | 否 | 插件作者 |

> `version` 与 `downloadUrl` 在最终生效数据中必须存在：  
> - 可直接写在 `plugins[]` 中；  
> - 也可由 `statsUrl` 提供并覆盖。

### `statsUrl` 对应文件结构（可选）

若配置了 `statsUrl`，其返回对象应为 `Record<pluginId, stats>`：

```json
{
  "example-plugin": {
    "version": "1.2.4",
    "downloadUrl": "https://github.com/owner/repo/releases/download/v1.2.4/example-plugin.zip",
    "downloads": 1234,
    "updateTime": "2026-01-01T00:00:00.000Z"
  }
}
```

---

## ❤️ 特别鸣谢
本插件的渲染推送渲染样式借鉴于 [@DenFengLai](https://github.com/DenFengLai/) 大佬开发的 [DF-Plugin](https://github.com/Denfenglai/DF-Plugin)

## 📜 开源协议

本项目采用 [MIT License](LICENSE) 协议开源。

---

## 🤝 贡献与反馈

欢迎通过 [Issues](https://github.com/xiowo/napcat-plugin-update-checker/issues) 或 [Pull Requests](https://github.com/xiowo/napcat-plugin-update-checker/pulls) 提交反馈与改进建议。
