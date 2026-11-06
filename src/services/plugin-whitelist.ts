import type { PluginLogger } from 'napcat-types/napcat-onebot/network/plugin/types';

interface PluginLoader {
    getRejectReason(pluginId: string, pluginDir: string): string | null;
    findPluginDirById(pluginId: string): string | null;
}

export interface PluginWhitelistManager {
    loader: PluginLoader;
    getPluginInfo(pluginId: string): unknown;
    loadDirectoryPlugin(dirname: string): Promise<void>;
}

export function normalizePluginWhitelist(value: unknown): string[] {
    const values = Array.isArray(value) ? value : [value];
    return [...new Set(values
        .filter((item): item is string => typeof item === 'string')
        .flatMap(item => item.split(/[,，\s]+/))
        .filter(Boolean))];
}

export function installPluginWhitelist(manager: PluginWhitelistManager, pluginIds: string[]) {
    const allowed = new Set(normalizePluginWhitelist(pluginIds));
    const loader = manager.loader;
    const originalGetRejectReason = loader.getRejectReason;
    function getRejectReason(this: PluginLoader, pluginId: string, pluginDir: string): string | null {
        const reason = originalGetRejectReason.call(this, pluginId, pluginDir);
        return reason === 'not in official plugin whitelist' && allowed.has(pluginId) ? null : reason;
    }
    loader.getRejectReason = getRejectReason;

    return {
        async registerPlugins(logger: Pick<PluginLogger, 'warn'>): Promise<void> {
            for (const pluginId of allowed) {
                if (manager.getPluginInfo(pluginId)) continue;
                try {
                    const dirname = loader.findPluginDirById(pluginId);
                    if (!dirname) {
                        logger.warn(`白名单插件未安装: ${pluginId}`);
                        continue;
                    }
                    await manager.loadDirectoryPlugin(dirname);
                } catch (error) {
                    logger.warn(`注册白名单插件失败: ${pluginId}`, error);
                }
            }
        },
        dispose(): void {
            if (loader.getRejectReason === getRejectReason) {
                loader.getRejectReason = originalGetRejectReason;
            }
        },
    };
}
