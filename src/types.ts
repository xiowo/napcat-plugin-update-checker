/**
 * 类型定义文件
 * 定义插件内部使用的接口和类型
 *
 * 注意：OneBot 相关类型（OB11Message, OB11PostSendMsg 等）
 * 以及插件框架类型（NapCatPluginContext, PluginModule 等）
 * 均来自 napcat-types 包，无需在此重复定义。
 */

// ==================== 插件配置 ====================

/**
 * 插件主配置接口
 */
export interface PluginConfig {
    /** 全局开关：是否启用插件功能 */
    enabled: boolean;
    /** 触发命令前缀 */
    commandPrefix: string;
    /** 同一命令请求冷却时间（秒），0 表示不限制 */
    cooldownSeconds: number;
    /** 主人 QQ（多个使用英文逗号分隔），设置后仅主人可执行管理命令 */
    masterQQ: string;
    /** 黑名单用户列表（QQ 号字符串） */
    blacklist: string[];
    /** 按群的单独配置 */
    groupConfigs: Record<string, GroupConfig>;
    /** 更新模式：notify 仅通知，auto 自动更新（仅推送更新结果，不再发送发现更新提醒） */
    updateMode: 'auto' | 'notify';
    /** 是否启用定时检查 */
    enableSchedule: boolean;
    /** 检查间隔（分钟） */
    checkInterval: number;
    /** 通知群列表 */
    notifyGroups: string[];
    /** 通知用户列表 */
    notifyUsers: string[];
    /** 自动更新插件列表（空列表表示全部） */
    autoUpdatePlugins: string[];
    /** 忽略更新的插件列表 */
    ignoredPlugins: string[];
    /** 选中的 Raw 镜像 */
    selectedRawMirror: string;
    /** 选中的下载镜像 */
    selectedDownloadMirror: string;
    /** 自定义 Raw 加速源列表 */
    rawMirrors?: string[];
    /** 自定义下载加速源列表 */
    downloadMirrors?: string[];
    /** 插件市场源列表 */
    pluginSources: PluginSource[];
    /** 彩蛋配置：是否启用自定义合并转发信息 */
    customForwardInfo?: boolean;
    /** 彩蛋配置：自定义合并转发 QQ 号（不填则使用机器人自身） */
    customForwardQQ?: string;
    /** 彩蛋配置：自定义合并转发昵称（不填则使用机器人自身） */
    customForwardName?: string;
    /** 主题色预设：warm/blue/green/purple/custom */
    themePreset?: 'warm' | 'blue' | 'green' | 'purple' | 'custom';
    /** 自定义主题主色（HEX） */
    themeCustomColor?: string;
}

/**
 * 插件市场源接口
 */
export interface PluginSource {
    name: string;
    url: string;
    enabled: boolean;
    isBuiltIn?: boolean;
}

/**
 * 群配置
 */
export interface GroupConfig {
    /** 是否启用此群的功能 */
    enabled?: boolean;
}

// ==================== 更新相关类型 ====================

/**
 * 插件信息类型
 */
export interface PluginInfo {
    /** 插件包名（商店 ID） */
    name: string;
    /** 内部 ID（NapCat 插件 ID） */
    internalId: string;
    /** 插件目录 ID */
    fileId?: string;
    /** 商店中的插件 ID（来自 .store-meta.json） */
    storeId?: string;
    /** 商店源名称（来自 .store-meta.json） */
    storeSource?: string;
    /** 显示名称 */
    displayName: string;
    /** 当前版本 */
    currentVersion: string;
    /** 状态 */
    status: 'active' | 'stopped' | 'disabled';
    /** 主页链接 */
    homepage: string;
}

/**
 * 商店元数据类型
 */
export interface StoreMeta {
    storeId: string;
    displayName: string;
    installedAt: string;
    source?: string;
}

/**
 * 更新信息类型
 */
export interface UpdateInfo {
    /** 插件包名 */
    pluginName: string;
    /** 显示名称 */
    displayName: string;
    /** 当前版本 */
    currentVersion: string;
    /** 最新版本 */
    latestVersion: string;
    /** 下载链接 */
    downloadUrl: string;
    /** 下载镜像 */
    mirror?: string;
    /** 变更日志 */
    changelog: string;
    /** 发布时间 */
    publishedAt: string;
    /** 商店源名称 */
    source?: string;
}

/**
 * 镜像延迟测试结果类型
 */
export interface MirrorPingResult {
    /** 镜像 URL */
    url: string;
    /** 镜像标签 */
    label: string;
    /** 延迟（毫秒），-1 表示失败 */
    latency: number;
    /** 是否成功 */
    ok: boolean;
}
