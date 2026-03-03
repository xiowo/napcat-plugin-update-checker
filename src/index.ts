/**
 * NapCat 插件模板 - 主入口
 *
 * 导出 PluginModule 接口定义的生命周期函数，NapCat 加载插件时会调用这些函数。
 *
 * 生命周期：
 *   plugin_init        → 插件加载时调用（必选）
 *   plugin_onmessage   → 收到事件时调用（需通过 post_type 判断事件类型）
 *   plugin_onevent     → 收到所有 OneBot 事件时调用
 *   plugin_cleanup     → 插件卸载/重载时调用
 *
 * 配置相关：
 *   plugin_config_ui          → 导出配置 Schema，用于 WebUI 自动生成配置面板
 *   plugin_get_config         → 自定义配置读取
 *   plugin_set_config         → 自定义配置保存
 *   plugin_on_config_change   → 配置变更回调
 *
 * @author MortalCat
 * @license MIT
 */



import type { PluginModule, PluginConfigSchema, NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import { EventType } from 'napcat-types/napcat-onebot/event/index';

import { buildConfigSchema } from './config';
import { pluginState } from './core/state';
import { handleMessage } from './handlers/message-handler';
import { startScheduler, stopScheduler } from './services/scheduler';
import {
    pingRawMirrors,
    pingDownloadMirrors,
    GITHUB_RAW_MIRRORS,
    DOWNLOAD_MIRRORS,
    installPluginWithResult,
    hasCachedPluginIcon,
    getCachedPluginIconPath
} from './services/updater';
import type { PluginConfig, PluginSource } from './types';
import * as fs from 'fs';
import * as path from 'path';

// ==================== 配置 UI Schema ====================

/** NapCat WebUI 读取此导出来展示配置面板 */
export let plugin_config_ui: PluginConfigSchema = [];

// ==================== 生命周期函数 ====================



/**
 * 插件初始化（必选）
 */
export const plugin_init: PluginModule['plugin_init'] = async (ctx) => {
    try {
        // 初始化全局状态（加载配置）
        pluginState.init(ctx);

        ctx.logger.info('插件初始化中...');

        // 生成配置 Schema（用于 NapCat WebUI 配置面板）
        plugin_config_ui = buildConfigSchema(ctx);

        // 注册 WebUI 路由
        registerWebUIRoutes(ctx);

        // 启动定时检查更新
        startScheduler();

        ctx.logger.info('插件初始化完成');
    } catch (error) {
        ctx.logger.error('插件初始化失败:', error);
    }
};

/**
 * 消息/事件处理（可选）
 * 收到事件时调用，需通过 post_type 判断是否为消息事件
 */
export const plugin_onmessage: PluginModule['plugin_onmessage'] = async (ctx, event) => {
    // 仅处理消息事件
    if (event.post_type !== EventType.MESSAGE) return;
    // 检查插件是否启用
    if (!pluginState.config.enabled) return;
    // 委托给消息处理器
    await handleMessage(ctx, event);
};

/**
 * 事件处理（可选）
 * 处理所有 OneBot 事件（通知、请求等）
 */
export const plugin_onevent: PluginModule['plugin_onevent'] = async (ctx, event) => {
    // TODO: 在这里处理通知、请求等非消息事件
};

/**
 * 插件卸载/重载（可选）
 * 必须清理定时器、关闭连接等资源
 */
export const plugin_cleanup: PluginModule['plugin_cleanup'] = async (ctx) => {
    try {
        // 停止定时检查更新
        stopScheduler();
        // 清理其他资源
        pluginState.cleanup();
        ctx.logger.info('插件已卸载');
    } catch (e) {
        ctx.logger.warn('插件卸载时出错:', e);
    }
};

// ==================== 配置管理钩子 ====================

/** 获取当前配置 */
export const plugin_get_config: PluginModule['plugin_get_config'] = async (ctx) => {
    return pluginState.config;
};

/** 设置配置（完整替换，由 NapCat WebUI 调用） */
export const plugin_set_config: PluginModule['plugin_set_config'] = async (ctx, config) => {
    const prevEnableSchedule = pluginState.config.enableSchedule;
    const prevCheckInterval = pluginState.config.checkInterval;

    pluginState.replaceConfig(config as PluginConfig);

    if (
        prevEnableSchedule !== pluginState.config.enableSchedule ||
        prevCheckInterval !== pluginState.config.checkInterval
    ) {
        // startScheduler 内部会先 stop 再按 enableSchedule 决定是否启动
        startScheduler();
        ctx.logger.info('检测到定时配置变更，已重建定时任务');
    }

    ctx.logger.info('配置已通过 WebUI 更新');
};

/**
 * 配置变更回调
 * 当 WebUI 中修改单个配置项时触发（需配置项标记 reactive: true）
 */
export const plugin_on_config_change: PluginModule['plugin_on_config_change'] = async (
    ctx, ui, key, value, currentConfig
) => {
    try {
        const prevEnableSchedule = pluginState.config.enableSchedule;
        const prevCheckInterval = pluginState.config.checkInterval;

        pluginState.updateConfig({ [key]: value });

        if (
            prevEnableSchedule !== pluginState.config.enableSchedule ||
            prevCheckInterval !== pluginState.config.checkInterval
        ) {
            // startScheduler 内部会先 stop 再按 enableSchedule 决定是否启动
            startScheduler();
            ctx.logger.info('检测到定时配置变更，已重建定时任务');
        }

        ctx.logger.debug(`配置项 ${key} 已更新`);
    } catch (err) {
        ctx.logger.error(`更新配置项 ${key} 失败:`, err);
    }
};

// ==================== WebUI API 端点 ====================

const URL_ASCII_SAFE_REGEX = /^[A-Za-z0-9:/._~?#[\]@!$&'()*+,;=%-]+$/;

/** 校验镜像/URL */
function isAsciiSafeUrl(value: string): boolean {
    return Boolean(value) && URL_ASCII_SAFE_REGEX.test(value);
}

/** 锁定插件源名称 */
function normalizePluginSourcesWithLockedName(
    incoming: unknown,
    existing: PluginSource[]
): PluginSource[] {
    const list = Array.isArray(incoming) ? incoming : [];
    const existingByUrl = new Map(
        existing
            .map((s) => [String(s.url || '').trim(), s] as const)
            .filter(([url]) => Boolean(url))
    );

    const out: PluginSource[] = [];
    for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const src = item as Partial<PluginSource>;

        const url = String(src.url || '').trim();
        if (!url) continue;
        if (!isAsciiSafeUrl(url)) continue;

        const old = existingByUrl.get(url);
        const lockedName = old ? old.name : String(src.name || '').trim();
        const finalName = lockedName || url;

        out.push({
            name: finalName,
            url,
            enabled: Boolean(src.enabled),
            isBuiltIn: old?.isBuiltIn ?? Boolean(src.isBuiltIn),
        });
    }

    return out;
}

/**
 * 注册 WebUI 路由
 */
function registerWebUIRoutes(ctx: NapCatPluginContext) {
    const base = (ctx as any).router;
    if (!base) return;

    /** 统一读取 JSON Body，兼容 req.body 为空的场景 */
    const readJsonBody = async (req: any, logPrefix: string): Promise<Record<string, any>> => {
        const current = req?.body;
        if (current && typeof current === 'object' && Object.keys(current).length > 0) {
            return current;
        }

        try {
            const raw = await new Promise<string>((resolve, reject) => {
                let data = '';
                req.on('data', (chunk: any) => (data += chunk));
                req.on('end', () => resolve(data));
                req.on('error', reject);
            });

            if (!raw) return {};
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (e) {
            ctx.logger.error(`${logPrefix} 解析请求体失败:`, e);
            return {};
        }
    };

    // 插件信息脚本
    if (base.get) {
        base.get('/static/plugin-info.js', (_req: any, res: any) => {
            try {
                res.type('application/javascript');
                res.send(`window.__PLUGIN_NAME__ = ${JSON.stringify(ctx.pluginName)};`);
            } catch (e) {
                res.status(500).send('// failed to generate plugin-info');
            }
        });
    }

    // 静态资源目录
    if (base.static) base.static('/static', 'webui');

    if (!base.get || !base.post) return;

    // 注册扩展页面
    if (base.page) {
        base.page({
            path: 'update-checker-dashboard',
            title: '更新检查器',
            icon: '🔄',
            htmlFile: 'webui/dashboard.html',
            description: '管理插件更新配置和通知设置'
        });
    }

    // 状态查询
    base.get('/status', async (_req: any, res: any) => {
        try {
            res.json({
                code: 0,
                data: {
                    uptimeFormatted: pluginState.getUptimeFormatted(),
                    config: pluginState.config
                }
            });
        } catch (e) {
            res.json({
                code: -1,
                message: String(e)
            });
        }
    });

    // 插件图标读取（安装/更新后缓存到 config/plugins/<pluginId>/icon.png）
    base.get('/plugin-icon/:pluginName', async (req: any, res: any) => {
        try {
            const pluginName = String(req.params?.pluginName || '').trim();
            if (!pluginName) return res.status(400).end();

            if (!hasCachedPluginIcon(pluginName)) {
                return res.status(404).end();
            }

            const iconPath = getCachedPluginIconPath(pluginName);
            if (!fs.existsSync(iconPath)) {
                return res.status(404).end();
            }

            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.type('image/png');
            res.send(fs.readFileSync(iconPath));
        } catch (_e) {
            return res.status(404).end();
        }
    });

    // 插件列表
    base.get('/plugins', async (_req: any, res: any) => {
        try {
            const plugins = [];
            // 尝试从插件管理器获取已安装插件
            if (pluginState.pluginManager) {
                const installedPlugins = pluginState.pluginManager.getAllPlugins();
                const pluginBasePath = pluginState.pluginManager.getPluginPath();
                for (const plugin of installedPlugins) {
                    // 统一 id / name 解析逻辑，使其与 updater.ts/商店索引 一致
                    const pkgName = plugin.packageJson?.name;
                    const pluginId = pkgName || plugin.id || plugin.fileId;
                    const folderId = String(plugin.id || plugin.fileId || '');

                    const iconUrl = hasCachedPluginIcon(pluginId)
                        ? `/plugin-icon/${encodeURIComponent(pluginId)}`
                        : '';

                    // 读取商店元数据，获取商店 ID 和源信息
                    let storeId = '';
                    let storeSource = '';
                    try {
                        const storeMetaPath = path.join(pluginBasePath, folderId, '.store-meta.json');
                        if (fs.existsSync(storeMetaPath)) {
                            const meta = JSON.parse(fs.readFileSync(storeMetaPath, 'utf8'));
                            storeId = meta.storeId || '';
                            storeSource = meta.source || '';
                        }
                    } catch (_e) { /* 忽略读取失败 */ }

                    plugins.push({
                        name: pluginId,
                        internalId: String(plugin.id),
                        fileId: folderId,
                        storeId: storeId,
                        storeSource: storeSource,
                        displayName: plugin.displayName || plugin.packageJson?.plugin || plugin.name || plugin.id,
                        author: plugin.author || plugin.packageJson?.author || '',
                        description: plugin.description || plugin.packageJson?.description || '',
                        currentVersion: plugin.version || plugin.packageJson?.version || '0.0.0',
                        status: !plugin.enable ? 'disabled' : plugin.loaded ? 'active' : 'stopped',
                        homepage: plugin.homepage || plugin.packageJson?.homepage || '',
                        icon: iconUrl
                    });
                }
            }
            res.json({
                code: 0,
                data: plugins
            });
        } catch (error) {
            ctx.logger.error('获取插件列表失败:', error);
            res.json({
                code: -1,
                message: '获取插件列表失败'
            });
        }
    });

    // 插件信息
    base.get('/plugin-info/:pluginName', async (req: any, res: any) => {
        try {
            const pluginName = req.params.pluginName;
            if (pluginState.pluginManager) {
                const installedPlugins = pluginState.pluginManager.getAllPlugins();
                const plugin = installedPlugins.find((p: any) => {
                    const pkgName = p.packageJson?.name;
                    const pid = pkgName || p.id || p.fileId;
                    return pid === pluginName || p.id === pluginName;
                });

                if (plugin) {
                    const pkgName = plugin.packageJson?.name;
                    const pluginId = pkgName || plugin.id || plugin.fileId;
                    const iconUrl = hasCachedPluginIcon(pluginId)
                        ? `/plugin-icon/${encodeURIComponent(pluginId)}`
                        : '';

                    res.json({
                        code: 0,
                        data: {
                            name: pluginId,
                            internalId: String(plugin.id),
                            displayName: plugin.displayName || plugin.packageJson?.plugin || plugin.name || plugin.id,
                            author: plugin.author || plugin.packageJson?.author || '',
                            description: plugin.description || plugin.packageJson?.description || '',
                            currentVersion: plugin.version || plugin.packageJson?.version || '0.0.0',
                            status: !plugin.enable ? 'disabled' : plugin.loaded ? 'active' : 'stopped',
                            homepage: plugin.homepage || plugin.packageJson?.homepage || '',
                            icon: iconUrl
                        }
                    });
                } else {
                    res.json({
                        code: -1,
                        message: '插件不存在'
                    });
                }
            } else {
                res.json({
                    code: -1,
                    message: '插件管理器不可用'
                });
            }
        } catch (error) {
            ctx.logger.error('获取插件信息失败:', error);
            res.json({
                code: -1,
                message: '获取插件信息失败'
            });
        }
    });



    // 自动更新插件管理
    base.post('/auto-update-plugins', async (req: any, res: any) => {
        try {
            const body = await readJsonBody(req, '自动更新插件');
            const { pluginName } = body || {};
            if (!pluginName) {
                return res.json({ code: -1, message: '插件名不能为空' });
            }
            if (!pluginState.config.autoUpdatePlugins.includes(pluginName)) {
                pluginState.config.autoUpdatePlugins.push(pluginName);
                pluginState.saveConfig();
            }
            res.json({ code: 0, data: pluginState.config.autoUpdatePlugins });
        } catch (e) {
            res.json({ code: -1, message: String(e) });
        }
    });

    base.delete('/auto-update-plugins', async (_req: any, res: any) => {
        try {
            pluginState.config.autoUpdatePlugins = [];
            pluginState.saveConfig();
            res.json({ code: 0, data: [] });
        } catch (e) {
            res.json({ code: -1, message: String(e) });
        }
    });

    // 删除指定自动更新插件
    base.delete('/auto-update-plugins/:index', async (req: any, res: any) => {
        try {
            const index = parseInt(req.params?.index || '');
            if (index >= 0 && index < pluginState.config.autoUpdatePlugins.length) {
                pluginState.config.autoUpdatePlugins.splice(index, 1);
                pluginState.saveConfig();
            }
            res.json({ code: 0, data: pluginState.config.autoUpdatePlugins });
        } catch (e) {
            res.json({ code: -1, message: String(e) });
        }
    });

    // 黑名单插件管理
    base.post('/ignored-plugins', async (req: any, res: any) => {
        try {
            const body = await readJsonBody(req, '黑名单插件');
            const { pluginName } = body || {};
            if (!pluginName) {
                return res.json({ code: -1, message: '插件名不能为空' });
            }
            if (!pluginState.config.ignoredPlugins.includes(pluginName)) {
                pluginState.config.ignoredPlugins.push(pluginName);
                pluginState.saveConfig();
            }
            res.json({ code: 0, data: pluginState.config.ignoredPlugins });
        } catch (e) {
            res.json({ code: -1, message: String(e) });
        }
    });

    base.delete('/ignored-plugins', async (_req: any, res: any) => {
        try {
            pluginState.config.ignoredPlugins = [];
            pluginState.saveConfig();
            res.json({ code: 0, data: [] });
        } catch (e) {
            res.json({ code: -1, message: String(e) });
        }
    });

    // 删除指定黑名单插件
    base.delete('/ignored-plugins/:index', async (req: any, res: any) => {
        try {
            const index = parseInt(req.params?.index || '');
            if (index >= 0 && index < pluginState.config.ignoredPlugins.length) {
                pluginState.config.ignoredPlugins.splice(index, 1);
                pluginState.saveConfig();
            }
            res.json({ code: 0, data: pluginState.config.ignoredPlugins });
        } catch (e) {
            res.json({ code: -1, message: String(e) });
        }
    });

    // 镜像管理
    base.get('/mirrors', async (_req: any, res: any) => {
        try {
            res.json({
                code: 0,
                data: {
                    rawMirrors: pluginState.config.rawMirrors || GITHUB_RAW_MIRRORS,
                    downloadMirrors: pluginState.config.downloadMirrors || DOWNLOAD_MIRRORS,
                    selectedRawMirror: pluginState.config.selectedRawMirror,
                    selectedDownloadMirror: pluginState.config.selectedDownloadMirror
                }
            });
        } catch (e) {
            res.json({ code: -1, message: String(e) });
        }
    });

    base.post('/mirrors', async (req: any, res: any) => {
        try {
            const body = await readJsonBody(req, '镜像配置');
            const prevEnableSchedule = pluginState.config.enableSchedule;
            const prevCheckInterval = pluginState.config.checkInterval;
            if (body?.rawMirrors !== undefined) {
                if (!Array.isArray(body.rawMirrors)) {
                    return res.json({ code: -1, message: 'rawMirrors 必须是数组' });
                }
                const normalized = body.rawMirrors.map((v: any) => String(v).trim()).filter(Boolean);
                if (!normalized.every((v: string) => isAsciiSafeUrl(v))) {
                    return res.json({ code: -1, message: 'rawMirrors 仅允许英文 URL 字符（如 a-zA-Z0-9:/._-）' });
                }
                pluginState.config.rawMirrors = normalized;
            }

            if (body?.downloadMirrors !== undefined) {
                if (!Array.isArray(body.downloadMirrors)) {
                    return res.json({ code: -1, message: 'downloadMirrors 必须是数组' });
                }
                const normalized = body.downloadMirrors.map((v: any) => String(v).trim()).filter(Boolean);
                if (!normalized.every((v: string) => isAsciiSafeUrl(v))) {
                    return res.json({ code: -1, message: 'downloadMirrors 仅允许英文 URL 字符（如 a-zA-Z0-9:/._-）' });
                }
                pluginState.config.downloadMirrors = normalized;
            }

            if (body?.selectedRawMirror !== undefined) {
                const selectedRawMirror = String(body.selectedRawMirror || '').trim();
                if (selectedRawMirror && !isAsciiSafeUrl(selectedRawMirror)) {
                    return res.json({ code: -1, message: 'selectedRawMirror 仅允许英文 URL 字符（如 a-zA-Z0-9:/._-）' });
                }
                pluginState.config.selectedRawMirror = selectedRawMirror;
            }

            if (body?.selectedDownloadMirror !== undefined) {
                const selectedDownloadMirror = String(body.selectedDownloadMirror || '').trim();
                if (selectedDownloadMirror && selectedDownloadMirror !== 'direct' && !isAsciiSafeUrl(selectedDownloadMirror)) {
                    return res.json({ code: -1, message: 'selectedDownloadMirror 仅允许英文 URL 字符（如 a-zA-Z0-9:/._-）' });
                }
                pluginState.config.selectedDownloadMirror = selectedDownloadMirror;
            }
            if (body?.notifyGroups !== undefined) pluginState.config.notifyGroups = body.notifyGroups;
            if (body?.notifyUsers !== undefined) pluginState.config.notifyUsers = body.notifyUsers;
            if (body?.enabled !== undefined) pluginState.config.enabled = body.enabled;
            if (body?.commandPrefix !== undefined) pluginState.config.commandPrefix = body.commandPrefix;
            if (body?.cooldownSeconds !== undefined) pluginState.config.cooldownSeconds = body.cooldownSeconds;
            if (body?.masterQQ !== undefined) pluginState.config.masterQQ = String(body.masterQQ || '').trim();

            if (body?.blacklist !== undefined) {
                if (Array.isArray(body.blacklist)) {
                    pluginState.config.blacklist = body.blacklist.map((v: any) => String(v).trim()).filter(Boolean);
                } else {
                    pluginState.config.blacklist = String(body.blacklist || '')
                        .split(/[,，\s]+/)
                        .map((v: string) => v.trim())
                        .filter(Boolean);
                }
            }

            if (body?.updateMode !== undefined) pluginState.config.updateMode = body.updateMode;
            if (body?.enableSchedule !== undefined) pluginState.config.enableSchedule = body.enableSchedule;
            if (body?.checkInterval !== undefined) pluginState.config.checkInterval = body.checkInterval;
            if (body?.autoUpdatePlugins !== undefined) pluginState.config.autoUpdatePlugins = body.autoUpdatePlugins;
            if (body?.ignoredPlugins !== undefined) pluginState.config.ignoredPlugins = body.ignoredPlugins;
            if (body?.themePreset !== undefined) pluginState.config.themePreset = body.themePreset;
            if (body?.themeCustomColor !== undefined) pluginState.config.themeCustomColor = body.themeCustomColor;
            pluginState.saveConfig();

            if (
                prevEnableSchedule !== pluginState.config.enableSchedule ||
                prevCheckInterval !== pluginState.config.checkInterval
            ) {
                // startScheduler 内部会先 stop 再按 enableSchedule 决定是否启动
                startScheduler();
                ctx.logger.info('检测到定时配置变更，已重建定时任务');
            }

            res.json({ code: 0, message: 'success' });
        } catch (e) {
            res.json({ code: -1, message: String(e) });
        }
    });

    base.get('/mirrors/ping-raw', async (_req: any, res: any) => {
        try {
            const results = await pingRawMirrors();
            res.json({ code: 0, data: results });
        } catch (e) {
            res.json({ code: -1, message: String(e) });
        }
    });

    base.get('/mirrors/ping-download', async (_req: any, res: any) => {
        try {
            const results = await pingDownloadMirrors();
            res.json({ code: 0, data: results });
        } catch (e) {
            res.json({ code: -1, message: String(e) });
        }
    });

    // 插件市场源管理
    base.post('/plugin-sources', async (req: any, res: any) => {
        try {
            const body = await readJsonBody(req, '插件市场源');
            if (body?.pluginSources !== undefined) {
                const oldSources = pluginState.config.pluginSources || [];
                const nextSources = normalizePluginSourcesWithLockedName(body.pluginSources, oldSources);

                // 若检测到同 URL 改名，记录日志但以旧名称为准
                const oldNameByUrl = new Map(oldSources.map(s => [String(s.url || '').trim(), s.name]));
                for (const s of nextSources) {
                    const oldName = oldNameByUrl.get(s.url);
                    if (oldName && oldName !== s.name) {
                        ctx.logger.warn(`插件源名称不可修改，已保留原名称: ${oldName} (${s.url})`);
                    }
                }

                pluginState.config.pluginSources = nextSources;
                pluginState.saveConfig();
            }
            res.json({ code: 0, message: 'success' });
        } catch (e) {
            res.json({ code: -1, message: String(e) });
        }
    });

    // 从商店安装插件
    base.post('/install-plugin', async (req: any, res: any) => {
        try {
            ctx.logger.info('收到安装插件请求');
            const body = await readJsonBody(req, '安装插件');
            const { pluginName, displayName, version, downloadUrl, mirror, source } = body || {};
            ctx.logger.info('提取的参数:', {
                pluginName,
                displayName,
                version,
                downloadUrl,
                mirror,
                source
            });
            if (!pluginName || !downloadUrl) {
                ctx.logger.error('缺少插件名或下载地址');
                return res.json({ code: -1, message: '缺少插件名或下载地址' });
            }

            ctx.logger.info(`WebUI 请求安装插件: ${pluginName}`);

            const updateInfo = {
                pluginName,
                displayName: displayName || pluginName,
                currentVersion: '0.0.0',
                latestVersion: version || '0.0.0',
                downloadUrl,
                mirror: mirror,
                changelog: '',
                publishedAt: '',
                source: source,
            };

            ctx.logger.info('调用 installPluginWithResult:', updateInfo);
            const result = await installPluginWithResult(updateInfo);
            ctx.logger.info('安装结果:', result);
            if (result.ok) {
                res.json({ code: 0, message: result.message });
            } else {
                res.json({ code: -1, message: result.message || `插件 ${displayName || pluginName} 安装失败` });
            }
        } catch (e) {
            ctx.logger.error('安装插件失败:', e);
            res.json({ code: -1, message: String(e) });
        }
    });

    // 导入本地插件（zip 文件 base64 或文件夹路径）
    base.post('/import-plugin', async (req: any, res: any) => {
        try {
            const body = await readJsonBody(req, '导入插件');
            const { fileName, fileData, folderPath } = body || {};
            const fsModule = await import('fs');
            const pathModule = await import('path');
            const osModule = await import('os');
            const fs = fsModule.default || fsModule;
            const pathLib = pathModule.default || pathModule;
            const os = osModule.default || osModule;

            const pm = pluginState.pluginManager;
            if (!pm) {
                return res.json({ code: -1, message: 'pluginManager 不可用' });
            }

            function copyDirSync(src: string, dest: string): void {
                if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
                for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
                    const s = pathLib.join(src, entry.name);
                    const d = pathLib.join(dest, entry.name);
                    if (entry.isDirectory()) copyDirSync(s, d);
                    else fs.copyFileSync(s, d);
                }
            }

            if (folderPath) {
                // 从文件夹路径导入
                if (!fs.existsSync(folderPath)) {
                    return res.json({ code: -1, message: '文件夹路径不存在' });
                }
                const pkgJsonPath = pathLib.join(folderPath, 'package.json');
                if (!fs.existsSync(pkgJsonPath)) {
                    return res.json({ code: -1, message: '目标文件夹中没有 package.json，不是有效的插件' });
                }
                const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
                const pluginId = pkgJson.name || pathLib.basename(folderPath);
                const pluginsDir = pm.getPluginPath();
                const destDir = pathLib.join(pluginsDir, pluginId);

                copyDirSync(folderPath, destDir);

                // 加载插件
                try {
                    const existing = pm.getPluginInfo(pluginId);
                    if (existing) {
                        await pm.reloadPlugin(pluginId);
                    } else {
                        await pm.loadPluginById(pluginId);
                    }
                } catch (e) {
                    ctx.logger.warn(`加载插件 ${pluginId} 失败（可能需要重启）:`, e);
                }

                ctx.logger.info(`从文件夹导入插件成功: ${pluginId}`);
                return res.json({ code: 0, message: `插件 ${pkgJson.plugin || pluginId} 导入成功` });
            }

            if (fileData && fileName) {
                // 从 base64 文件数据导入 zip
                const ext = pathLib.extname(fileName).toLowerCase();
                if (ext !== '.zip') {
                    return res.json({ code: -1, message: '只支持 .zip 格式的插件文件' });
                }

                const tmpDir = os.tmpdir();
                const tmpZip = pathLib.join(tmpDir, `plugin_import_${Date.now()}.zip`);
                const buf = Buffer.from(fileData, 'base64');
                fs.writeFileSync(tmpZip, buf);

                // 解压到临时目录读取 package.json
                const { execSync } = await import('child_process');
                const tmpExtract = tmpZip + '_extract';
                if (fs.existsSync(tmpExtract)) fs.rmSync(tmpExtract, { recursive: true, force: true });
                fs.mkdirSync(tmpExtract, { recursive: true });

                const isWin = process.platform === 'win32';
                if (isWin) {
                    execSync(`powershell -Command "Expand-Archive -Path '${tmpZip}' -DestinationPath '${tmpExtract}' -Force"`, { timeout: 30000 });
                } else {
                    execSync(`unzip -o "${tmpZip}" -d "${tmpExtract}"`, { timeout: 30000 });
                }

                // 找到根目录
                let srcDir = tmpExtract;
                const entries = fs.readdirSync(tmpExtract);
                if (entries.length === 1) {
                    const single = pathLib.join(tmpExtract, entries[0]);
                    if (fs.statSync(single).isDirectory()) srcDir = single;
                }

                const pkgPath = pathLib.join(srcDir, 'package.json');
                if (!fs.existsSync(pkgPath)) {
                    fs.rmSync(tmpExtract, { recursive: true, force: true });
                    fs.unlinkSync(tmpZip);
                    return res.json({ code: -1, message: 'zip 中没有 package.json，不是有效的插件' });
                }
                const pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                const pluginId = pkgJson.name || fileName.replace(/\.zip$/i, '');
                const pluginsDir = pm.getPluginPath();
                const destDir = pathLib.join(pluginsDir, pluginId);

                copyDirSync(srcDir, destDir);

                // 清理临时文件
                fs.rmSync(tmpExtract, { recursive: true, force: true });
                fs.unlinkSync(tmpZip);

                // 加载插件
                try {
                    const existing = pm.getPluginInfo(pluginId);
                    if (existing) {
                        await pm.reloadPlugin(pluginId);
                    } else {
                        await pm.loadPluginById(pluginId);
                    }
                } catch (e) {
                    ctx.logger.warn(`加载插件 ${pluginId} 失败（可能需要重启）:`, e);
                }

                ctx.logger.info(`从 zip 导入插件成功: ${pluginId}`);
                return res.json({ code: 0, message: `插件 ${pkgJson.plugin || pluginId} 导入成功` });
            }

            res.json({ code: -1, message: '请提供 zip 文件或文件夹路径' });
        } catch (e) {
            ctx.logger.error('导入插件失败:', e);
            res.json({ code: -1, message: String(e) });
        }
    });

    // 彩蛋配置保存接口
    base.post('/secret-config', async (req: any, res: any) => {
        try {
            const body = await readJsonBody(req, '彩蛋配置');
            const { customForwardInfo, customForwardQQ, customForwardName } = body || {};
            pluginState.updateConfig({
                customForwardInfo: Boolean(customForwardInfo),
                customForwardQQ: String(customForwardQQ || ''),
                customForwardName: String(customForwardName || ''),
            });
            ctx.logger.info('彩蛋配置已更新');
            res.json({ code: 0, message: 'ok' });
        } catch (err) {
            ctx.logger.error('更新彩蛋配置失败:', err);
            res.status(500).json({ code: -1, message: String(err) });
        }
    });
}
