/**
 * 插件配置模块
 * 定义默认配置值和 WebUI 配置 Schema
 */

import type { NapCatPluginContext, PluginConfigSchema } from 'napcat-types/napcat-onebot/network/plugin/types';
import type { PluginConfig } from './types';

/** 默认配置 */
export const DEFAULT_CONFIG: PluginConfig = {
    enabled: true,
    commandPrefix: '#更新插件',
    cooldownSeconds: 60,
    masterQQ: '',
    silentNoPermission: false,
    groupConfigs: {},
    // 更新相关配置
    updateMode: 'notify',
    enableSchedule: true,
    checkInterval: 30,
    notifyGroups: [],
    notifyUsers: [],
    autoUpdatePlugins: [],
    ignoredPlugins: [],
    // 镜像相关配置
    selectedRawMirror: '',
    selectedDownloadMirror: '',
    // 插件市场源
    pluginSources: [
        { name: '社区插件库', url: 'https://raw.githubusercontent.com/HolyFoxTeam/napcat-plugin-community-index/refs/heads/main/plugins.v4.json', enabled: true, isBuiltIn: true }
    ],
    // Git 更新推送
    gitProviders: [
        { provider: 'GitHub', token: '' },
        { provider: 'Gitee', token: '' },
        { provider: 'Gitcode', token: '' },
        { provider: 'Gitea', token: '' },
        { provider: 'CNB', token: '' },
    ],
    gitPushConfigs: [],
    gitAutoFetchDefaultBranch: true,
    gitRenderMode: 'text',
    gitEnableSchedule: true,
    gitCheckInterval: 30,
    // 主题配置
    themePreset: 'warm',
    themeCustomColor: '#e8b896',
};

/**
 * 构建 WebUI 配置 Schema
 *
 * 使用 ctx.NapCatConfig 提供的构建器方法生成配置界面：
 *   - boolean(key, label, defaultValue?, description?, reactive?)  → 开关
 *   - text(key, label, defaultValue?, description?, reactive?)     → 文本输入
 *   - number(key, label, defaultValue?, description?, reactive?)   → 数字输入
 *   - select(key, label, options, defaultValue?, description?)     → 下拉单选
 *   - multiSelect(key, label, options, defaultValue?, description?) → 下拉多选
 *   - html(content)     → 自定义 HTML 展示（不保存值）
 *   - plainText(content) → 纯文本说明
 *   - combine(...items)  → 组合多个配置项为 Schema
 */
export function buildConfigSchema(ctx: NapCatPluginContext): PluginConfigSchema {
    return ctx.NapCatConfig.combine(
        // 插件信息头部
        ctx.NapCatConfig.html(`
            <div style="padding: 16px; background: linear-gradient(135deg, #F5E6D8, rgba(245, 230, 216, 0.6)); border: 1px solid rgba(210, 180, 150, 0.5); border-radius: 12px; position: relative; overflow: visible;">
                <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 8px;">
                    <div style="width: 36px; height: 36px; background: rgba(210, 140, 80, 0.2); border-radius: 8px; display: flex; align-items: center; justify-content: center;">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#D28C50" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
                    </div>
                    <div>
                        <h3 style="margin: 0; font-size: 16px; font-weight: 600; color: #8B5A2B;">插件更新检测</h3>
                        <p style="margin: 2px 0 0; font-size: 12px; color: #A0826D;">napcat-plugin-update-checker</p>
                    </div>
                </div>
                <p style="margin: 0; font-size: 13px; color: #8B7355;">
                    自动检查并更新已安装的 NapCat 插件 |
                    前往 <code style="background: rgba(210, 140, 80, 0.15); padding: 2px 6px; border-radius: 4px; color: #D28C50;">扩展页面</code> 进行配置
                </p>
                <!-- 狐狸 emoji 装饰 -->
                <style>
                    .fox-emoji {
                        position: absolute;
                        right: 16px;
                        top: 50%;
                        transform: translateY(-50%);
                        font-size: 32px;
                        cursor: default;
                        transition: transform 0.3s ease, filter 0.3s ease;
                        filter: drop-shadow(0 2px 4px rgba(0,0,0,0.1));
                    }
                    .fox-emoji:hover {
                        transform: translateY(-50%) scale(1.2) rotate(10deg);
                        filter: drop-shadow(0 4px 8px rgba(210, 140, 80, 0.4));
                    }
                </style>
                <span class="fox-emoji">🦊</span>
            </div>
        `)
    );
}
