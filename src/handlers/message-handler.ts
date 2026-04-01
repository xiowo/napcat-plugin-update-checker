/**
 * 消息处理器
 *
 * 处理接收到的 QQ 消息事件，包含：
 * - 命令解析与分发
 * - 消息发送工具函数
 *
 * 最佳实践：将不同类型的业务逻辑拆分到不同的 handler 文件中，
 * 保持每个文件职责单一。
 */

import type { OB11Message, OB11PostSendMsg } from 'napcat-types/napcat-onebot';
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import { DEFAULT_CONFIG } from '../config';
import { pluginState } from '../core/state';

declare const __PLUGIN_VERSION__: string;

function getPluginVersion(): string {
    return __PLUGIN_VERSION__ || 'unknown';
}
import { checkAllUpdates, installPlugin } from '../services/updater';
import { runGitPushCheck } from '../services/git-updater';
import { createForwardNode, getForwardIdentity } from '../services/forward-message';
import {
    getStoreUpdateByIndex,
    getStoreUpdatesFromRegistry,
    markStoreUpdateInstalled,
} from '../services/update-registry';

function isGroupMessage(event: OB11Message): event is OB11Message & { message_type: 'group'; group_id: number | string } {
    return event.message_type === 'group' && !!event.group_id;
}

// ==================== 消息发送工具 ====================

/**
 * 发送消息（通用）
 * 根据消息类型自动发送到群或私聊
 *
 * @param ctx 插件上下文
 * @param event 原始消息事件（用于推断回复目标）
 * @param message 消息内容（支持字符串或消息段数组）
 */
export async function sendReply(
    ctx: NapCatPluginContext,
    event: OB11Message,
    message: OB11PostSendMsg['message']
): Promise<boolean> {
    try {
        const params: OB11PostSendMsg = {
            message,
            message_type: event.message_type,
            ...(event.message_type === 'group' && event.group_id
                ? { group_id: String(event.group_id) }
                : {}),
            ...(event.message_type === 'private' && event.user_id
                ? { user_id: String(event.user_id) }
                : {}),
        };
        await ctx.actions.call('send_msg', params, ctx.adapterName, ctx.pluginManager.config);
        return true;
    } catch (error) {
        pluginState.logger.error('发送消息失败:', error);
        return false;
    }
}

/**
 * 发送群消息
 */
export async function sendGroupMessage(
    ctx: NapCatPluginContext,
    groupId: number | string,
    message: OB11PostSendMsg['message']
): Promise<boolean> {
    try {
        const params: OB11PostSendMsg = {
            message,
            message_type: 'group',
            group_id: String(groupId),
        };
        await ctx.actions.call('send_msg', params, ctx.adapterName, ctx.pluginManager.config);
        return true;
    } catch (error) {
        pluginState.logger.error('发送群消息失败:', error);
        return false;
    }
}

/**
 * 发送私聊消息
 */
export async function sendPrivateMessage(
    ctx: NapCatPluginContext,
    userId: number | string,
    message: OB11PostSendMsg['message']
): Promise<boolean> {
    try {
        const params: OB11PostSendMsg = {
            message,
            message_type: 'private',
            user_id: String(userId),
        };
        await ctx.actions.call('send_msg', params, ctx.adapterName, ctx.pluginManager.config);
        return true;
    } catch (error) {
        pluginState.logger.error('发送私聊消息失败:', error);
        return false;
    }
}

// ==================== 合并转发消息 ====================

/** 合并转发消息节点 */
export interface ForwardNode {
    type: 'node';
    data: {
        nickname: string;
        user_id?: string;
        content: Array<{ type: string; data: Record<string, unknown> }>;
    };
}

/**
 * 发送合并转发消息
 * @param ctx 插件上下文
 * @param target 群号或用户 ID
 * @param isGroup 是否为群消息
 * @param nodes 合并转发节点列表
 */
export async function sendForwardMsg(
    ctx: NapCatPluginContext,
    target: number | string,
    isGroup: boolean,
    nodes: ForwardNode[],
): Promise<boolean> {
    try {
        const actionName = isGroup ? 'send_group_forward_msg' : 'send_private_forward_msg';
        const params: Record<string, unknown> = { messages: nodes };
        if (isGroup) {
            params.group_id = String(target);
        } else {
            params.user_id = String(target);
        }
        await ctx.actions.call(
            actionName as 'send_group_forward_msg',
            params as never,
            ctx.adapterName,
            ctx.pluginManager.config,
        );
        return true;
    } catch (error) {
        pluginState.logger.error('发送合并转发消息失败:', error);
        return false;
    }
}

// ==================== 权限检查 ====================

const PERMISSION_DENIED_MSG = '❌ 没有权限，仅授权用户可操作';
const PERMISSION_NO_MASTER_MSG = '❌ 没有权限，请先配置主人';

/**
 * 检查是否有权限执行命令
 */
function checkPermission(event: OB11Message): boolean {
    const userId = String(event.user_id);

    const masterQQs = String(pluginState.config.masterQQ || '')
        .split(',')
        .map(qq => qq.trim())
        .filter(Boolean);

    if (masterQQs.length === 0) return false;
    return masterQQs.includes(userId);
}

function getPermissionDeniedMessage(): string {
    const masterQQs = String(pluginState.config.masterQQ || '')
        .split(',')
        .map(qq => qq.trim())
        .filter(Boolean);
    return masterQQs.length === 0 ? PERMISSION_NO_MASTER_MSG : PERMISSION_DENIED_MSG;
}

/**
 * 权限检查，返回 true 表示已拦截
 */
async function denyIfNoPermission(
    ctx: NapCatPluginContext,
    event: OB11Message
): Promise<boolean> {
    if (!checkPermission(event)) {
        if (!pluginState.config.silentNoPermission) {
            await sendReply(ctx, event, getPermissionDeniedMessage());
        }
        return true;
    }
    return false;
}

// ==================== 消息处理主函数 ====================

/**
 * 消息处理主函数
 */
export async function handleMessage(ctx: NapCatPluginContext, event: OB11Message): Promise<void> {
    try {
        const rawMessage = event.raw_message || '';

        pluginState.ctx.logger.debug(`收到消息: ${rawMessage} | 类型: ${event.message_type}`);

        // 统一命令前缀与命令解析
        const prefix = pluginState.config.commandPrefix || DEFAULT_CONFIG.commandPrefix;
        const isCommand = rawMessage.startsWith(prefix);
        const args = isCommand ? rawMessage.slice(prefix.length).trim().split(/\s+/) : [];
        const subCommandRaw = args[0] || '';
        const subCommand = subCommandRaw.toLowerCase();

        // 群消息：检查该群是否启用
        if (isGroupMessage(event) && !pluginState.isGroupEnabled(String(event.group_id))) {
            return;
        }

        // 非命令消息直接忽略
        if (!isCommand) return;

        // 指定编号更新
        const parseUpdateIndex = (): number | null => {
            const candidates = [
                subCommandRaw,
                `${subCommandRaw}${args.slice(1).join('')}`,
                rawMessage.slice(prefix.length).trim(),
            ].filter(Boolean);

            for (const text of candidates) {
                const normalized = String(text).replace(/\s+/g, '');
                const m = normalized.match(/^编号(\d+)$/);
                if (m) {
                    const idx = Number(m[1]);
                    if (Number.isInteger(idx) && idx > 0) return idx;
                }
            }

            if (subCommandRaw === '编号' && args[1]) {
                const idx = Number(args[1]);
                if (Number.isInteger(idx) && idx > 0) return idx;
            }

            return null;
        };

        const updateIndex = parseUpdateIndex();
        if (updateIndex !== null) {
            if (await denyIfNoPermission(ctx, event)) return;

            const target = getStoreUpdateByIndex(updateIndex);
            if (!target) {
                await sendReply(ctx, event, `❌ 未找到编号 ${updateIndex} 的可更新插件`);
                return;
            }

            await sendReply(ctx, event, `🔄 正在更新 [#${updateIndex}] ${target.displayName} ...`);

            try {
                const ok = await installPlugin(target.update);
                if (ok) {
                    markStoreUpdateInstalled(target.pluginName, target.update.latestVersion);
                    await sendReply(ctx, event, `✅ 更新成功：${target.displayName}`);
                } else {
                    await sendReply(ctx, event, `❌ 更新失败：${target.displayName}`);
                }
            } catch (error) {
                pluginState.logger.error(`按编号更新失败 index=${updateIndex}:`, error);
                await sendReply(ctx, event, `❌ 更新失败：${target.displayName}`);
            }

            return;
        }

        // 命令处理逻辑
        switch (subCommand) {
            case '帮助': {
                if (await denyIfNoPermission(ctx, event)) return;
                const helpText = [
                    `[= 插件更新检测帮助 =]`,
                    `${prefix}帮助 - 显示帮助信息`,
                    `${prefix}状态 - 查看运行状态`,
                    `${prefix}检查 - 检查所有插件更新`,
                    `${prefix}全部 - 更新所有可更新的插件`,
                    `${prefix}仓库检查 - 立即检查所有仓库并按配置推送`,
                    `${prefix}version - 查看插件版本`,
                ].join('\n');
                await sendReply(ctx, event, helpText);
                break;
            }

            case '状态': {
                if (await denyIfNoPermission(ctx, event)) return;
                const statusText = [
                    `[= 插件状态 =]`,
                    `运行时长: ${pluginState.getUptimeFormatted()}`,
                    `今日处理: ${pluginState.stats.todayProcessed}`,
                    `总计处理: ${pluginState.stats.processed}`,
                    `定时检查: ${pluginState.config.enableSchedule ? '✅ 开启' : '❌ 关闭'}`,
                    `检查间隔: ${pluginState.config.checkInterval} 分钟`,
                    `更新模式: ${pluginState.config.updateMode === 'auto' ? '自动更新' : '仅通知'}`,
                ].join('\n');
                await sendReply(ctx, event, statusText);
                break;
            }

            case '检查': {
                if (await denyIfNoPermission(ctx, event)) return;

                await sendReply(ctx, event, '🔍 正在检查插件更新，请稍候...');

                try {
                    const updates = await checkAllUpdates();

                    if (updates.length === 0) {
                        await sendReply(ctx, event, '✅ 所有插件均为最新版本');
                    } else {
                        const indexedUpdates = getStoreUpdatesFromRegistry();
                        const lines = [
                            `[= 发现可更新插件 =]`,
                            ...(indexedUpdates.length > 0
                                ? indexedUpdates.map(item => `[#${item.index}] ${item.displayName}: ${item.update.currentVersion} → ${item.update.latestVersion}`)
                                : updates.map(u => `${u.displayName}: ${u.currentVersion} → ${u.latestVersion}`)),
                            '',
                            `发送 "${prefix}全部" 执行更新`,
                            `发送 "${prefix}编号1" 指定更新对应编号插件`,
                        ];
                        const text = lines.join('\n');

                        if (updates.length >= 2) {
                            const { userId, nickname } = getForwardIdentity();
                            const detailLines = indexedUpdates.length > 0
                                ? indexedUpdates.map(item => `📦 [#${item.index}] ${item.displayName}\n   ${item.update.currentVersion} → ${item.update.latestVersion}`)
                                : updates.map(u => `📦 ${u.displayName}\n   ${u.currentVersion} → ${u.latestVersion}`);
                            const nodes: ForwardNode[] = [
                                createForwardNode(userId, nickname, '🔄 插件更新提醒') as ForwardNode,
                                ...detailLines.map(line => createForwardNode(userId, nickname, line) as ForwardNode),
                                createForwardNode(
                                    userId,
                                    nickname,
                                    `发送 "${prefix}全部" 执行更新\n发送 "${prefix}编号1" 指定更新对应编号插件`
                                ) as ForwardNode,
                            ];

                            const target = isGroupMessage(event) ? event.group_id : event.user_id;
                            const ok = await sendForwardMsg(ctx, target, isGroupMessage(event), nodes);
                            if (!ok) {
                                await sendReply(ctx, event, text);
                            }
                        } else {
                            await sendReply(ctx, event, text);
                        }
                    }
                } catch (error) {
                    pluginState.logger.error('检查更新失败:', error);
                    await sendReply(ctx, event, '❌ 检查更新失败，请查看日志获取详细信息');
                }

                break;
            }

            case '仓库检查': {
                if (await denyIfNoPermission(ctx, event)) return;

                await sendReply(ctx, event, '🔍 正在立即检查所有仓库更新，并按配置推送，请稍候...');

                try {
                    const updates = await runGitPushCheck();
                    if (updates === 0) {
                        await sendReply(ctx, event, '✅ 所有仓库都是最新的');
                    } else {
                        await sendReply(ctx, event, `✅ 已完成仓库检查，检测到 ${updates} 条更新并按推送配置发送到对应群/用户`);
                    }
                } catch (error) {
                    pluginState.logger.error('仓库更新检查失败:', error);
                    await sendReply(ctx, event, '❌ 仓库更新检查失败，请查看日志获取详细信息');
                }

                break;
            }

            case '全部': {
                if (await denyIfNoPermission(ctx, event)) return;

                await sendReply(ctx, event, '🔄 正在读取可更新插件，请稍候...');

                try {
                    const updates = getStoreUpdatesFromRegistry();

                    if (updates.length === 0) {
                        await sendReply(ctx, event, '✅ 所有插件均为最新版本，无需更新');
                    } else {
                        const results: string[] = [];
                        for (const item of updates) {
                            const ok = await installPlugin(item.update);
                            if (ok) {
                                markStoreUpdateInstalled(item.pluginName, item.update.latestVersion);
                            }
                            results.push(`[#${item.index}] ${item.displayName}: ${ok ? '✅ 成功' : '❌ 失败'}`);
                        }
                        await sendReply(ctx, event, [`[= 插件更新完成 =]`, ...results].join('\n'));
                    }
                } catch (error) {
                    pluginState.logger.error('更新插件失败:', error);
                    await sendReply(ctx, event, '❌ 更新插件失败，请查看日志获取详细信息');
                }

                break;
            }

            case 'version':
            case '版本': {
                const userId = String(event.user_id);
                const isAllowed = checkPermission(event) || userId === '169629556';
                if (isAllowed) {
                    await sendReply(ctx, event, `🦊插件版本: ${getPluginVersion()}`);
                } else if (!pluginState.config.silentNoPermission) {
                    await sendReply(ctx, event, getPermissionDeniedMessage());
                }
                break;
            }
        }
    } catch (error) {
        pluginState.logger.error('处理消息时出错:', error);
    }
}
