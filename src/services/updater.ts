/**
 * 更新检测核心逻辑
 * 实现插件更新检测、版本比较、安装等功能
 */

import fs from 'fs';
import path from 'path';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import type { PluginInfo, UpdateInfo, MirrorPingResult, StoreMeta } from '../types';
import { pluginState } from '../core/state';

// 插件商店索引源将从 pluginState.config.pluginSources 动态读取

// GitHub Raw 镜像
export const GITHUB_RAW_MIRRORS = [
    'https://github.chenc.dev/',
    'https://ghproxy.cfd/',
    'https://ghproxy.cc/',
    'https://gh-proxy.net/'
];

// GitHub 文件加速镜像
export const DOWNLOAD_MIRRORS = [
    'https://github.chenc.dev/',
    'https://ghproxy.cfd/',
    'https://github.tbedu.top/',
    'https://ghproxy.cc/',
    'https://gh.monlor.com/',
    'https://cdn.akaere.online/',
    'https://gh.idayer.com/',
    'https://gh.llkk.cc/',
    'https://ghpxy.hwinzniej.top/',
    'https://github-proxy.memory-echoes.cn/',
    'https://git.yylx.win/',
    'https://gitproxy.mrhjx.cn/',
    'https://gh.fhjhy.top/',
    'https://gp.zkitefly.eu.org/',
    'https://gh-proxy.com/',
    'https://ghfile.geekertao.top/',
    'https://j.1lin.dpdns.org/',
    'https://ghproxy.imciel.com/',
    'https://github-proxy.teach-english.tech/',
    'https://gh.927223.xyz/',
    'https://github.ednovas.xyz/',
    'https://ghf.xn--eqrr82bzpe.top/',
    'https://gh.dpik.top/',
    'https://gh.jasonzeng.dev/',
    'https://gh.xxooo.cf/',
    'https://gh.bugdey.us.kg/',
    'https://ghm.078465.xyz/',
    'https://j.1win.ggff.net/',
    'https://tvv.tw/',
    'https://gitproxy.127731.xyz/',
    'https://gh.inkchills.cn/',
    'https://ghproxy.cxkpro.top/',
    'https://gh.sixyin.com/',
    'https://github.geekery.cn/',
    'https://git.669966.xyz/',
    'https://gh.5050net.cn/',
    'https://gh.felicity.ac.cn/',
    'https://github.dpik.top/',
    'https://ghp.keleyaa.com/',
    'https://gh.wsmdn.dpdns.org/',
    'https://ghproxy.monkeyray.net/',
    'https://fastgit.cc/',
    'https://gh.catmak.name/',
    'https://gh.noki.icu/'
];

interface StorePlugin {
    id: string;
    name: string;
    version: string;
    downloadUrl: string;
    description?: string;
    author?: string;
    source?: string;
}

export interface InstallPluginResult {
    ok: boolean;
    message: string;
}

/** 比较版本号，返回 true 表示 remote > local */
function isNewer(local: string, remote: string): boolean {
    const normalize = (v: string) => v.replace(/^v/i, '');
    const lp = normalize(local).split('.').map(Number);
    const rp = normalize(remote).split('.').map(Number);
    for (let i = 0; i < Math.max(lp.length, rp.length); i++) {
        const l = lp[i] || 0;
        const r = rp[i] || 0;
        if (r > l) return true;
        if (r < l) return false;
    }
    return false;
}

/** 通过 pluginManager 获取已安装插件列表 */
function getInstalledFromManager(): PluginInfo[] {
    const pm = pluginState.pluginManager;
    if (!pm) {
        pluginState.logger.warn('pluginManager 不可用');
        return [];
    }

    const pluginBasePath = pm.getPluginPath?.() || '';
    const all = pm.getAllPlugins();
    const plugins: PluginInfo[] = all
        .filter((p: any) => !!p.id)
        .map((p: any) => {
            // 优先使用 package.json 的 name 作为标识（与商店索引一致）
            const pkgName = p.packageJson?.name;
            const pluginId = pkgName || p.id || p.fileId;
            const folderId = String(p.id || p.fileId || '');

            let storeId = '';
            let storeSource = '';

            // 读取安装时写入的商店元数据，用于“按源限定更新”
            try {
                if (pluginBasePath && folderId) {
                    const storeMetaPath = path.join(pluginBasePath, folderId, '.store-meta.json');
                    if (fs.existsSync(storeMetaPath)) {
                        const meta = JSON.parse(fs.readFileSync(storeMetaPath, 'utf8')) as StoreMeta;
                        storeId = meta.storeId || '';
                        storeSource = meta.source || '';
                    }
                }
            } catch {
            }

            return {
                name: pluginId,
                internalId: String(p.id),
                fileId: folderId,
                storeId: storeId || undefined,
                storeSource: storeSource || undefined,
                displayName: p.packageJson?.plugin || p.name || p.id,
                currentVersion: p.version || '0.0.0',
                status: !p.enable ? 'disabled' : p.loaded ? 'active' : 'stopped',
                homepage: p.packageJson?.homepage || '',
            };
        });

    pluginState.installedPlugins = plugins;
    return plugins;
}

/** 从商店索引获取数据（按源分别返回，不做跨源合并） */
async function fetchStoreIndexBySource(): Promise<Map<string, Map<string, StorePlugin>>> {
    const selected = pluginState.config.selectedRawMirror;
    const configuredMirrors = pluginState.config.rawMirrors?.length
        ? pluginState.config.rawMirrors
        : GITHUB_RAW_MIRRORS;

    const mirrorsWithDirect = configuredMirrors.includes('direct')
        ? configuredMirrors
        : [...configuredMirrors, 'direct'];

    const mirrors = selected
        ? [selected, ...mirrorsWithDirect.filter(m => m !== selected)]
        : mirrorsWithDirect;

    const configuredSources = pluginState.config.pluginSources || [];
    const enabledSources = configuredSources.filter(s => s.enabled);

    const fallbackCommunitySource = {
        name: '社区插件库（回退）',
        url: 'https://raw.githubusercontent.com/HolyFoxTeam/napcat-plugin-community-index/refs/heads/main/plugins.v4.json',
        enabled: true,
    };
    const sources = enabledSources.length > 0 ? enabledSources : [fallbackCommunitySource];

    if (enabledSources.length === 0) {
        pluginState.logger.warn('未启用任何插件市场源，已自动回退到社区源');
    }

    const sourceMap = new Map<string, Map<string, StorePlugin>>();

    for (const sourceObj of sources) {
        const source = sourceObj.url;
        const sourceKey = sourceObj.name || source;
        let sourceBest = new Map<string, StorePlugin>();
        let sourceBestLabel = '';

        for (const mirror of mirrors) {
            try {
                const isDirect = !mirror || mirror === 'direct' || mirror === 'https://raw.githubusercontent.com';
                const baseUrl = isDirect ? source : `${mirror}${source}`;
                const url = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}t=${Date.now()}`;

                const res = await fetch(url, {
                    headers: { 'User-Agent': 'NapCat-WebUI', 'Cache-Control': 'no-cache' },
                    signal: AbortSignal.timeout(10000),
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

                const data = await res.json() as any;
                const plugins = Array.isArray(data?.plugins) ? data.plugins : [];

                const map = new Map<string, StorePlugin>();
                for (const p of plugins) {
                    if (p?.id && p?.version && p?.downloadUrl) {
                        map.set(p.id, {
                            id: p.id,
                            name: p.name || p.id,
                            version: p.version,
                            downloadUrl: p.downloadUrl,
                            description: p.description,
                            author: p.author,
                            source: sourceKey,
                        });
                    }
                }

                if (map.size === 0) {
                    continue;
                }

                const label = isDirect ? '直连' : '镜像';
                if (map.size > sourceBest.size) {
                    sourceBest = map;
                    sourceBestLabel = label;
                }

                // 指定镜像/直连成功后优先采用，减少等待
                if (isDirect || mirror === selected) {
                    break;
                }
            } catch (e) {
                pluginState.logger.debug(`源 ${sourceKey} 通过镜像 ${mirror || 'direct'} 拉取失败: ${getErrorMessage(e)}`);
            }
        }

        if (sourceBest.size > 0) {
            pluginState.logger.info(`源 ${sourceKey} 获取成功（${sourceBestLabel || '镜像'}），共 ${sourceBest.size} 个插件`);
            sourceMap.set(sourceKey, sourceBest);
        } else {
            pluginState.logger.warn(`源 ${sourceKey} 获取失败，已跳过`);
        }
    }

    if (sourceMap.size === 0) {
        pluginState.logger.error(`所有商店索引源均不可用（共尝试 ${mirrors.length} 个镜像）`);
        return sourceMap;
    }

    pluginState.logger.info(`商店索引获取完成，共可用 ${sourceMap.size} 个源`);
    return sourceMap;
}

/** 仅用于历史兼容：无来源元数据时，才走跨源合并兜底 */
function buildMergedStoreIndex(sourceIndexMap: Map<string, Map<string, StorePlugin>>): Map<string, StorePlugin> {
    const mergedMap = new Map<string, StorePlugin>();
    for (const sourceMap of sourceIndexMap.values()) {
        for (const [id, item] of sourceMap) {
            const exists = mergedMap.get(id);
            if (!exists || isNewer(exists.version, item.version)) {
                mergedMap.set(id, item);
            }
        }
    }
    return mergedMap;
}

function findStoreInfoForInstalled(
    plugin: PluginInfo,
    storeMap: Map<string, StorePlugin>
): StorePlugin | null {
    const candidates = [
        plugin.storeId,
        plugin.name,
        plugin.fileId,
        plugin.internalId,
    ].filter((v): v is string => Boolean(v));

    for (const id of candidates) {
        const matched = storeMap.get(id);
        if (matched) return matched;
    }

    return null;
}

/** 检查所有插件更新 */
export async function checkAllUpdates(): Promise<UpdateInfo[]> {
    pluginState.logger.info('开始检查插件更新...');

    const installed = getInstalledFromManager();
    const sourceStoreMap = await fetchStoreIndexBySource();
    const mergedStoreMap = buildMergedStoreIndex(sourceStoreMap);

    // 清理 autoUpdatePlugins 中已不存在的插件
    const installedNames = new Set(installed.map(p => p.name));
    const autoList = pluginState.config.autoUpdatePlugins;
    if (autoList.length > 0) {
        const cleaned = autoList.filter(name => installedNames.has(name));
        if (cleaned.length !== autoList.length) {
            pluginState.config.autoUpdatePlugins = cleaned;
            pluginState.saveConfig();
        }
    }

    if (sourceStoreMap.size === 0) {
        pluginState.logger.warn('商店索引为空，无法检查更新（可能是网络问题）');
        return [];
    }

    const ignored = new Set(pluginState.config.ignoredPlugins);
    const updates: UpdateInfo[] = [];

    for (const plugin of installed) {
        if (ignored.has(plugin.name)) continue;

        // 有商店元数据时：只按对应源检查，不跨源比版本
        const targetStoreMap = plugin.storeSource
            ? sourceStoreMap.get(plugin.storeSource)
            : mergedStoreMap;

        if (!targetStoreMap) continue;

        const storeInfo = findStoreInfoForInstalled(plugin, targetStoreMap);
        if (!storeInfo) continue;

        if (isNewer(plugin.currentVersion, storeInfo.version)) {
            updates.push({
                pluginName: storeInfo.id,
                displayName: plugin.displayName,
                currentVersion: plugin.currentVersion,
                latestVersion: storeInfo.version,
                downloadUrl: storeInfo.downloadUrl,
                changelog: '',
                publishedAt: '',
                source: storeInfo.source,
            });
        }
    }

    pluginState.availableUpdates = updates;
    pluginState.lastCheckTime = Date.now();

    if (updates.length > 0) {
        pluginState.logger.info(`发现 ${updates.length} 个可更新: ${updates.map(u => `${u.displayName} ${u.currentVersion} → ${u.latestVersion}`).join(', ')}`);
    } else {
        pluginState.logger.info('所有插件均为最新版本');
    }
    return updates;
}

/** 根据插件包名（商店 id）查找 NapCat 内部 id */
function resolveInternalId(pluginName: string): string {
    const found = pluginState.installedPlugins.find(p => p.name === pluginName);
    return found?.internalId || pluginName;
}

/** 检查单个插件更新 */
export async function checkSinglePlugin(pluginName: string): Promise<UpdateInfo | null> {
    pluginState.logger.info(`检查单个插件更新: ${pluginName}`);

    const pm = pluginState.pluginManager;
    if (!pm) { pluginState.logger.warn('pluginManager 不可用'); return null; }

    // 先刷新一次安装列表，拿到最新的 storeId/storeSource 元数据
    getInstalledFromManager();
    const installed = pluginState.installedPlugins.find(p => p.name === pluginName);

    const internalId = resolveInternalId(pluginName);
    const entry = pm.getPluginInfo(internalId);
    if (!entry) { pluginState.logger.warn(`未找到插件: ${pluginName} (内部id: ${internalId})`); return null; }

    const currentVersion = entry.version || '0.0.0';
    const sourceStoreMap = await fetchStoreIndexBySource();
    const mergedStoreMap = buildMergedStoreIndex(sourceStoreMap);

    // 有商店元数据时：只按对应源检查，不跨源比版本
    const targetStoreMap = installed?.storeSource
        ? sourceStoreMap.get(installed.storeSource)
        : mergedStoreMap;

    if (!targetStoreMap) {
        pluginState.logger.info(`${pluginName} 已记录来源 ${installed?.storeSource || ''}，但该源当前不可用`);
        return null;
    }

    // 兼容 storeId 缺失场景：按 storeId/name/fileId/internalId 多候选匹配
    const storeInfo = installed
        ? findStoreInfoForInstalled(installed, targetStoreMap) || targetStoreMap.get(pluginName)
        : targetStoreMap.get(pluginName);

    if (!storeInfo) { pluginState.logger.info(`${pluginName} 不在商店中`); return null; }

    // 更新 installedPlugins 中的版本
    if (installed) installed.currentVersion = currentVersion;

    pluginState.availableUpdates = pluginState.availableUpdates.filter(
        u => u.pluginName !== pluginName && u.pluginName !== storeInfo.id
    );

    if (isNewer(currentVersion, storeInfo.version)) {
        const update: UpdateInfo = {
            pluginName: storeInfo.id,
            displayName: entry.packageJson?.plugin || entry.name || pluginName,
            currentVersion,
            latestVersion: storeInfo.version,
            downloadUrl: storeInfo.downloadUrl,
            changelog: '',
            publishedAt: '',
            source: storeInfo.source,
        };
        pluginState.availableUpdates.push(update);
        pluginState.logger.info(`${pluginName}: ${currentVersion} → ${storeInfo.version} 有更新`);
        return update;
    }

    pluginState.logger.info(`${pluginName} 已是最新 (${currentVersion})`);
    return null;
}

/** 下载文件 */
async function downloadWithMirror(url: string, destPath: string): Promise<void> {
    const selected = pluginState.config.selectedDownloadMirror;
    const downloadMirrorsConfig = pluginState.config.downloadMirrors?.length
        ? pluginState.config.downloadMirrors
        : DOWNLOAD_MIRRORS;

    const mirrorsWithDirect = downloadMirrorsConfig.includes('direct')
        ? downloadMirrorsConfig
        : [...downloadMirrorsConfig, 'direct'];

    const mirrors = selected
        ? [selected, ...mirrorsWithDirect.filter(m => m !== selected)]
        : mirrorsWithDirect;

    for (const mirror of mirrors) {
        try {
            const finalUrl = (mirror && mirror !== 'direct') ? `${mirror}${url}` : url;
            const res = await fetch(finalUrl, {
                headers: { 'User-Agent': 'napcat-plugin-update-checker' },
                signal: AbortSignal.timeout(120000),
                redirect: 'follow',
            });
            if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
            const fileStream = createWriteStream(destPath);
            await pipeline(Readable.fromWeb(res.body as any), fileStream);
            return;
        } catch (e) {
            pluginState.logger.debug(`下载失败，镜像 ${mirror || 'direct'}: ${getErrorMessage(e)}`);
        }
    }
    throw new Error('所有下载镜像均失败');
}

function copyDirSync(src: string, dest: string): void {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory()) copyDirSync(s, d);
        else fs.copyFileSync(s, d);
    }
}

function getErrorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
}

/** 安装/更新单个插件 */
export async function installPluginWithResult(update: UpdateInfo): Promise<InstallPluginResult> {
    const pm = pluginState.pluginManager;
    if (!pm) {
        const message = 'pluginManager 不可用';
        pluginState.logger.error(message);
        return { ok: false, message };
    }

    let operationText: '安装' | '更新' = update.currentVersion === '0.0.0' ? '安装' : '更新';
    pluginState.logger.info(`正在${operationText} ${update.displayName} ${operationText === '安装' ? '' : '到 v' + update.latestVersion}...`);

    const pluginsDir = pm.getPluginPath();
    const tmpZip = path.join(pluginsDir, `temp_${Date.now()}.zip`);
    const tmpExtract = path.join(pluginsDir, `temp_extract_${Date.now()}`);

    const originalMirror = pluginState.config.selectedDownloadMirror;
    const usedCustomMirror = Boolean(update.mirror);

    try {
        // 如果提供了镜像，暂时覆盖配置中的镜像
        if (usedCustomMirror) {
            pluginState.config.selectedDownloadMirror = update.mirror || '';
            pluginState.logger.info(`使用指定镜像下载: ${update.mirror}`);
        }

        // 下载
        await downloadWithMirror(update.downloadUrl, tmpZip);

        // 解压到临时目录
        if (fs.existsSync(tmpExtract)) fs.rmSync(tmpExtract, { recursive: true, force: true });
        fs.mkdirSync(tmpExtract, { recursive: true });

        const isWin = process.platform === 'win32';
        if (isWin) {
            const { execSync } = await import('child_process');
            execSync(`powershell -Command "Expand-Archive -Path '${tmpZip}' -DestinationPath '${tmpExtract}' -Force"`, { timeout: 30000 });
        } else {
            const { execSync } = await import('child_process');
            execSync(`unzip -o "${tmpZip}" -d "${tmpExtract}"`, { timeout: 30000 });
        }

        // 找到实际内容目录
        let sourceDir = tmpExtract;
        const entries = fs.readdirSync(tmpExtract);
        if (entries.length === 1) {
            const single = path.join(tmpExtract, entries[0]);
            if (fs.statSync(single).isDirectory()) sourceDir = single;
        }

        // 检查是否包含 package.json
        const packageJsonPath = path.join(sourceDir, 'package.json');
        if (!fs.existsSync(packageJsonPath)) {
            throw new Error('插件格式错误：缺少 package.json 文件');
        }

        // 读取 package.json 获取插件名称
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        const pluginName = packageJson.name;
        if (!pluginName) {
            throw new Error('插件格式错误：package.json 中缺少 name 字段');
        }

        // 检查是否已安装同名插件
        const pluginDir = path.join(pluginsDir, pluginName);
        const pluginExists = fs.existsSync(pluginDir);
        if (pluginExists && operationText === '安装') {
            operationText = '更新';
            pluginState.logger.info(`插件 ${pluginName} 已存在，自动切换为更新流程`);
        } else if (!pluginExists && operationText === '更新') {
            operationText = '安装';
            pluginState.logger.info(`插件 ${pluginName} 不存在，自动切换为安装流程`);
        }

        // 备份用户配置
        let configBackup: string | null = null;
        if (pluginExists) {
            configBackup = path.join(pluginsDir, `${pluginName}.config.bak`);
            const userConfigPath = path.join(pluginDir, 'data', 'config.json');
            if (fs.existsSync(userConfigPath)) {
                fs.copyFileSync(userConfigPath, configBackup);
            }
        }

        // 复制到目标目录
        if (fs.existsSync(pluginDir)) {
            fs.rmSync(pluginDir, { recursive: true, force: true });
        }
        fs.mkdirSync(pluginDir, { recursive: true });

        // 复制文件
        copyDirSync(sourceDir, pluginDir);

        // 写入商店元数据，方便后续匹配商店 ID 与已安装插件
        const storeMeta: StoreMeta = {
            storeId: update.pluginName,        // 商店索引中的 ID
            displayName: update.displayName,   // 商店中的显示名称
            installedAt: new Date().toISOString(),
            source: update.source,             // 商店源名称
        };
        fs.writeFileSync(path.join(pluginDir, '.store-meta.json'), JSON.stringify(storeMeta, null, 2), 'utf8');

        // 恢复用户配置
        if (configBackup && fs.existsSync(configBackup)) {
            const userConfigPath = path.join(pluginDir, 'data', 'config.json');
            const dataDir = path.join(pluginDir, 'data');
            if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
            fs.copyFileSync(configBackup, userConfigPath);
            fs.unlinkSync(configBackup);
        }

        // 通过 pluginManager 重载或加载插件
        const existingPlugins = pm.getAllPlugins();
        const existingPlugin = existingPlugins.find((p: any) => p.id === pluginName || p.packageJson?.name === pluginName);

        if (existingPlugin) {
            pluginState.logger.info(`重载插件: ${pluginName}`);
            await pm.reloadPlugin(existingPlugin.id);
        } else {
            pluginState.logger.info(`加载新插件: ${pluginName}`);
            // 尝试加载插件
            try {
                await pm.loadPluginById(pluginName);
            } catch (e) {
                pluginState.logger.warn(`加载插件失败: ${e}，可能需要手动重启`);
            }
        }

        // 更新成功后，从 availableUpdates 中移除该插件
        pluginState.availableUpdates = pluginState.availableUpdates.filter(u => u.pluginName !== update.pluginName);

        // 重新获取已安装插件列表
        getInstalledFromManager();

        const successMessage = `插件 ${update.displayName} ${operationText}成功`;
        pluginState.logger.info(`✅ ${successMessage}`);
        return { ok: true, message: successMessage };
    } catch (e) {
        const errorMessage = getErrorMessage(e);
        pluginState.logger.error(`${operationText} ${update.displayName} 失败: ${errorMessage}`);
        return { ok: false, message: errorMessage };
    } finally {
        // 恢复原始镜像配置
        if (usedCustomMirror) {
            pluginState.config.selectedDownloadMirror = originalMirror;
        }

        // 清理临时文件
        if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip);
        if (fs.existsSync(tmpExtract)) fs.rmSync(tmpExtract, { recursive: true, force: true });
    }
}

/** 安装/更新单个插件 */
export async function installPlugin(update: UpdateInfo): Promise<boolean> {
    const result = await installPluginWithResult(update);
    return result.ok;
}

/** 获取已安装插件列表（供 API 使用） */
export async function getInstalledPlugins(): Promise<PluginInfo[]> {
    return getInstalledFromManager();
}

/** 给镜像打标签 */
function mirrorLabel(url: string): string {
    if (!url || url === 'direct' || url === 'https://raw.githubusercontent.com') return '直连 (raw.githubusercontent.com)';
    try {
        return new URL(url).hostname;
    } catch { return url; }
}

function downloadMirrorLabel(url: string): string {
    if (!url || url === 'direct') return '直连 (github.com)';
    try {
        return new URL(url).hostname;
    } catch { return url; }
}

/** Ping 所有 Raw 镜像，返回延迟结果 */
export async function pingRawMirrors(): Promise<MirrorPingResult[]> {
    const mirrorsToTest = pluginState.config.rawMirrors || GITHUB_RAW_MIRRORS;
    const enabledSources = pluginState.config.pluginSources?.filter(s => s.enabled) || [];
    const source = enabledSources.length > 0
        ? enabledSources[0].url
        : 'https://raw.githubusercontent.com/HolyFoxTeam/napcat-plugin-community-index/refs/heads/main/plugins.v4.json';
    const results = await Promise.all(mirrorsToTest.map(async (mirror) => {
        const url = (mirror && mirror !== 'direct' && mirror !== 'https://raw.githubusercontent.com') ? `${mirror}${source}` : source;
        const start = Date.now();
        try {
            const res = await fetch(url, {
                method: 'HEAD',
                headers: { 'User-Agent': 'napcat-plugin-update-checker' },
                signal: AbortSignal.timeout(8000),
            });
            const latency = Date.now() - start;
            return { url: mirror, label: mirrorLabel(mirror), latency, ok: res.ok };
        } catch {
            return { url: mirror, label: mirrorLabel(mirror), latency: -1, ok: false };
        }
    }));
    return results.sort((a, b) => {
        if (a.ok && !b.ok) return -1;
        if (!a.ok && b.ok) return 1;
        return a.latency - b.latency;
    });
}

/** Ping 所有 下载 镜像，返回延迟结果 */
export async function pingDownloadMirrors(): Promise<MirrorPingResult[]> {
    const testUrl = 'https://github.com/NapNeko/NapCatQQ/releases/latest';
    const mirrorsToTest = pluginState.config.downloadMirrors || DOWNLOAD_MIRRORS;
    const results = await Promise.all(mirrorsToTest.map(async (mirror) => {
        const url = (mirror && mirror !== 'direct') ? `${mirror}${testUrl}` : testUrl;
        const start = Date.now();
        try {
            const res = await fetch(url, {
                method: 'HEAD',
                headers: { 'User-Agent': 'napcat-plugin-update-checker' },
                signal: AbortSignal.timeout(8000),
                redirect: 'follow',
            });
            const latency = Date.now() - start;
            return { url: mirror, label: downloadMirrorLabel(mirror), latency, ok: res.status >= 200 && res.status < 400 };
        } catch {
            return { url: mirror, label: downloadMirrorLabel(mirror), latency: -1, ok: false };
        }
    }));
    return results.sort((a, b) => {
        if (a.ok && !b.ok) return -1;
        if (!a.ok && b.ok) return 1;
        return a.latency - b.latency;
    });
}
