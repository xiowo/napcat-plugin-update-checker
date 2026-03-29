/**
 * 定时检查更新模块
 * 实现插件更新的定时检查和通知推送功能
 */

import { pluginState } from '../core/state';
import { DEFAULT_CONFIG } from '../config';
import { checkAllUpdates, installPlugin } from './updater';
import { getStoreUpdatesFromRegistry, markStoreUpdateInstalled } from './update-registry';
import { ensureGitDefaultBranches, runGitPushCheck } from './git-updater';
import { buildForwardNodesFromTexts, sendForwardMessage } from './forward-message';
import type { UpdateInfo } from '../types';

/** 首次商店检查定时器（用于 stopScheduler 时清理） */
let firstCheckTimer: ReturnType<typeof setTimeout> | null = null;
/** 首次 Git 检查定时器（用于 stopScheduler 时清理） */
let firstGitCheckTimer: ReturnType<typeof setTimeout> | null = null;
/** Git 检查定时器 */
let gitCheckTimer: ReturnType<typeof setInterval> | null = null;

/** 简单延迟 */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** 计算单条推送延迟：固定随机 0.5s ~ 1s */
function getPushDelayMs(): number {
    const min = 500;
    const max = 1000;
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** 避免触发风控 */
async function sendWithRateLimit(tasks: Array<() => Promise<void>>): Promise<void> {
    for (let i = 0; i < tasks.length; i++) {
        if (i > 0) await sleep(getPushDelayMs());
        await tasks[i]();
    }
}

function canSendMessage(): boolean {
    const ok = Boolean(pluginState.ctx.actions && pluginState.ctx.pluginManager.config);
    if (!ok) {
        pluginState.logger.warn(`发送消息跳过: actions=${!!pluginState.ctx.actions}, pmConfig=${!!pluginState.ctx.pluginManager.config}`);
    }
    return ok;
}

/** 发送文本消息 */
async function sendTextMessage(targetId: string, text: string, isGroup: boolean): Promise<void> {
    if (!canSendMessage()) return;

    const action = isGroup ? 'send_group_msg' : 'send_private_msg';
    const idKey = isGroup ? 'group_id' : 'user_id';
    const msg: unknown[] = [{ type: 'text', data: { text } }];

    pluginState.logger.info(`正在发送${isGroup ? '群' : '私聊'}消息到 ${targetId}`);
    await pluginState.ctx.actions.call(
        action as 'send_group_msg',
        { [idKey]: Number(targetId), message: msg } as never,
        pluginState.ctx.adapterName,
        pluginState.ctx.pluginManager.config
    ).catch((e: any) => {
        pluginState.logger.warn(`发送${isGroup ? '群' : '私聊'}消息到 ${targetId} 失败:`, e);
    });
}

interface UpdateIndexLookup {
    byStorePluginName: Map<string, number>;
    byInstalledPluginName: Map<string, number>;
    byDisplayVersion: Map<string, number>;
}

function buildUpdateIndexLookup(): UpdateIndexLookup {
    const list = getStoreUpdatesFromRegistry();
    const byStorePluginName = new Map<string, number>();
    const byInstalledPluginName = new Map<string, number>();
    const byDisplayVersion = new Map<string, number>();

    for (const item of list) {
        byStorePluginName.set(String(item.update.pluginName || ''), item.index);
        byInstalledPluginName.set(String(item.pluginName || ''), item.index);
        byDisplayVersion.set(`${item.displayName}@@${item.update.latestVersion}`, item.index);
    }

    return { byStorePluginName, byInstalledPluginName, byDisplayVersion };
}

function resolveUpdateIndex(update: UpdateInfo, lookup: UpdateIndexLookup): number | null {
    const keyByDisplayVersion = `${update.displayName}@@${update.latestVersion}`;
    const index = lookup.byStorePluginName.get(String(update.pluginName || ''))
        ?? lookup.byInstalledPluginName.get(String(update.pluginName || ''))
        ?? lookup.byDisplayVersion.get(keyByDisplayVersion);

    return typeof index === 'number' && index > 0 ? index : null;
}

/** 构建单个插件的更新通知文本 */
function buildSingleNotifyText(update: UpdateInfo, index: number | null): string {
    const lines: string[] = [];
    lines.push(`📦 ${index ? `[#${index}] ` : ''}${update.displayName}`);
    lines.push(`   ${update.currentVersion} → ${update.latestVersion}`);
    if (update.publishedAt) {
        lines.push(`   发布于 ${new Date(update.publishedAt).toLocaleString('zh-CN')}`);
    }
    if (update.changelog) {
        const short = update.changelog.split('\n').slice(0, 3).join('\n   ');
        lines.push(`   ${short}`);
    }
    return lines.join('\n');
}

/** 构建更新通知文本 */
function buildNotifyText(updates: UpdateInfo[]): string {
    const lines: string[] = ['🔄 插件更新提醒', ''];
    const prefix = pluginState.config.commandPrefix || DEFAULT_CONFIG.commandPrefix;
    const indexLookup = buildUpdateIndexLookup();

    for (const u of updates) {
        lines.push(buildSingleNotifyText(u, resolveUpdateIndex(u, indexLookup)));
        lines.push('');
    }

    if (pluginState.config.updateMode === 'notify') {
        lines.push(`发送 "${prefix}全部" 执行更新`);
        lines.push(`发送 "${prefix}编号1" 指定更新对应编号插件`);
    }
    return lines.join('\n');
}

/** 构建合并转发节点 */
function buildForwardNodes(updates: UpdateInfo[]): unknown[] {
    const indexLookup = buildUpdateIndexLookup();
    const texts: string[] = ['🔄 插件更新提醒'];

    for (const update of updates) {
        texts.push(buildSingleNotifyText(update, resolveUpdateIndex(update, indexLookup)));
    }

    if (pluginState.config.updateMode === 'notify') {
        const prefix = pluginState.config.commandPrefix || DEFAULT_CONFIG.commandPrefix;
        texts.push(`发送 "${prefix}全部" 执行更新\n发送 "${prefix}编号1" 指定更新对应编号插件`);
    }

    return buildForwardNodesFromTexts(texts);
}

function buildBroadcastTasks(
    groups: string[],
    users: string[],
    sender: (targetId: string, isGroup: boolean) => Promise<void>
): Array<() => Promise<void>> {
    return [
        ...groups.map(gid => () => sender(gid, true)),
        ...users.map(uid => () => sender(uid, false)),
    ];
}

/** 推送更新通知 */
async function pushNotification(updates: UpdateInfo[]): Promise<void> {
    if (updates.length === 0) return;

    const groups = pluginState.config.notifyGroups;
    const users = pluginState.config.notifyUsers;

    if (groups.length === 0 && users.length === 0) {
        pluginState.logger.warn('没有配置通知目标（notifyGroups 和 notifyUsers 均为空），跳过推送');
        return;
    }

    pluginState.logger.info(`准备推送 ${updates.length} 个更新通知，目标: 群=${JSON.stringify(groups)}, 用户=${JSON.stringify(users)}`);

    if (updates.length >= 2) {
        const nodes = buildForwardNodes(updates);
        const fallbackText = buildNotifyText(updates);
        const tasks = buildBroadcastTasks(groups, users, (targetId, isGroup) =>
            sendForwardMessage(targetId, nodes, isGroup, () => sendTextMessage(targetId, fallbackText, isGroup))
        );
        await sendWithRateLimit(tasks);
        return;
    }

    const text = buildNotifyText(updates);
    const tasks = buildBroadcastTasks(groups, users, (targetId, isGroup) =>
        sendTextMessage(targetId, text, isGroup)
    );
    await sendWithRateLimit(tasks);
}

/** 构建自动更新结果文本 */
function buildUpdateResultText(result: { update: UpdateInfo; ok: boolean }[]): string {
    const lines: string[] = ['🔄 插件自动更新完成', ''];
    const prefix = pluginState.config.commandPrefix || DEFAULT_CONFIG.commandPrefix;
    const indexLookup = buildUpdateIndexLookup();

    for (const item of result) {
        const u = item.update;
        const index = resolveUpdateIndex(u, indexLookup);
        lines.push(`${item.ok ? '✅' : '❌'} ${index ? `[#${index}] ` : ''}${u.displayName}`);
        lines.push(`   ${u.currentVersion} → ${u.latestVersion}`);
    }

    lines.push('');
    lines.push(`如需手动指定更新，发送 "${prefix}编号1"`);
    lines.push(`如需先刷新编号库，发送 "${prefix}检查"`);

    return lines.join('\n');
}

/** 构建自动更新结果合并转发节点 */
function buildResultForwardNodes(result: { update: UpdateInfo; ok: boolean }[]): unknown[] {
    const prefix = pluginState.config.commandPrefix || DEFAULT_CONFIG.commandPrefix;
    const indexLookup = buildUpdateIndexLookup();
    const texts: string[] = ['🔄 插件自动更新完成'];

    for (const item of result) {
        const u = item.update;
        const index = resolveUpdateIndex(u, indexLookup);
        texts.push(`${item.ok ? '✅' : '❌'} ${index ? `[#${index}] ` : ''}${u.displayName}\n   ${u.currentVersion} → ${u.latestVersion}`);
    }

    texts.push(`如需手动指定更新，发送 "${prefix}编号1"\n如需先刷新编号库，发送 "${prefix}检查"`);

    return buildForwardNodesFromTexts(texts);
}

/** 推送自动更新结果 */
async function pushUpdateResult(result: { update: UpdateInfo; ok: boolean }[]): Promise<void> {
    if (result.length === 0) return;

    const groups = pluginState.config.notifyGroups;
    const users = pluginState.config.notifyUsers;
    if (groups.length === 0 && users.length === 0) return;

    if (result.length >= 2) {
        const nodes = buildResultForwardNodes(result);
        const fallbackText = buildUpdateResultText(result);
        const tasks = buildBroadcastTasks(groups, users, (targetId, isGroup) =>
            sendForwardMessage(targetId, nodes, isGroup, () => sendTextMessage(targetId, fallbackText, isGroup))
        );
        await sendWithRateLimit(tasks);
        return;
    }

    const text = buildUpdateResultText(result);
    const tasks = buildBroadcastTasks(groups, users, (targetId, isGroup) =>
        sendTextMessage(targetId, text, isGroup)
    );
    await sendWithRateLimit(tasks);
}

/** 执行一次商店更新检查 */
export async function runScheduledCheck(): Promise<void> {
    pluginState.logger.info('商店插件定时检查开始...');
    const updates = await checkAllUpdates();

    if (updates.length === 0) return;

    // 过滤掉已通知过的更新
    const newUpdates = updates.filter(u => {
        const key = `${u.pluginName}@${u.latestVersion}`;
        return !pluginState.notifiedUpdates.has(key);
    });

    // 标记为已通知
    const markNotified = (list: UpdateInfo[]) => {
        for (const u of list) {
            pluginState.notifiedUpdates.add(`${u.pluginName}@${u.latestVersion}`);
        }
    };

    const mode = pluginState.config.updateMode;

    if (mode === 'auto') {
        const autoList = new Set(pluginState.config.autoUpdatePlugins);
        const toUpdate = autoList.size > 0
            ? updates.filter(u => autoList.has(u.pluginName))
            : updates;

        if (toUpdate.length === 0) return;

        const results: Array<{ update: UpdateInfo; ok: boolean }> = [];
        for (const update of toUpdate) {
            const ok = await installPlugin(update);
            results.push({ update, ok });
            // 更新成功后从已通知集合中移除
            if (ok) {
                pluginState.notifiedUpdates.delete(`${update.pluginName}@${update.latestVersion}`);
                // 自动更新成功后立即同步编号库版本
                markStoreUpdateInstalled(update.pluginName, update.latestVersion);
            }
        }

        // 更新完成后回报版本变动；多条使用合并转发
        await pushUpdateResult(results);
        return;
    }

    if (newUpdates.length > 0) {
        await pushNotification(newUpdates);
        markNotified(newUpdates);
    }
}

/** 执行一次 Git 推送检查 */
export async function runScheduledGitCheck(): Promise<void> {
    pluginState.logger.info('Git 推送定时检查开始...');
    await ensureGitDefaultBranches();
    await runGitPushCheck();
}

/** 启动定时检查 */
export function startScheduler(): void {
    stopScheduler();

    // 商店插件更新检测
    if (!pluginState.config.enableSchedule) {
        pluginState.logger.debug('商店插件定时检查已禁用');
    } else {
        const intervalMs = Math.max(pluginState.config.checkInterval, 1) * 60 * 1000;
        pluginState.checkTimer = setInterval(() => {
            runScheduledCheck().catch(e => pluginState.logger.error('商店插件定时检查异常: ' + e));
        }, intervalMs);
        pluginState.logger.info(`商店插件定时检查已启动，间隔 ${pluginState.config.checkInterval} 分钟`);

        // 启动后延迟 30 秒执行首次检查（可在 stopScheduler 中清理）
        firstCheckTimer = setTimeout(() => {
            firstCheckTimer = null;
            runScheduledCheck().catch(e => pluginState.logger.error('商店插件首次检查异常: ' + e));
        }, 30000);
    }

    // Git 推送检测
    if (!pluginState.config.gitEnableSchedule) {
        pluginState.logger.debug('Git 推送定时检查已禁用');
    } else {
        const gitIntervalMs = Math.max(pluginState.config.gitCheckInterval || 1, 1) * 60 * 1000;
        gitCheckTimer = setInterval(() => {
            runScheduledGitCheck().catch(e => pluginState.logger.error('Git 推送定时检查异常: ' + e));
        }, gitIntervalMs);
        pluginState.logger.info(`Git 推送定时检查已启动，间隔 ${pluginState.config.gitCheckInterval} 分钟`);

        firstGitCheckTimer = setTimeout(() => {
            firstGitCheckTimer = null;
            runScheduledGitCheck().catch(e => pluginState.logger.error('Git 推送首次检查异常: ' + e));
        }, 30000);
    }
}

/** 停止定时检查 */
export function stopScheduler(): void {
    if (pluginState.checkTimer) {
        clearInterval(pluginState.checkTimer);
        pluginState.checkTimer = null;
    }
    if (firstCheckTimer) {
        clearTimeout(firstCheckTimer);
        firstCheckTimer = null;
    }
    if (gitCheckTimer) {
        clearInterval(gitCheckTimer);
        gitCheckTimer = null;
    }
    if (firstGitCheckTimer) {
        clearTimeout(firstGitCheckTimer);
        firstGitCheckTimer = null;
    }
}
