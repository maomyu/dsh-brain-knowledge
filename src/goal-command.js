import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { executeGoalCommand } from '../vendor/harness-goal/index.ts'
import { sourceProjects } from './workflow.js'

export const inject = ['commands', 'goals', 'taskController', 'workspaceRegistry', 'tools']

export function apply(ctx) {
  ctx.on('tools/execute', (exec, next) => {
    if (exec.name !== 'create_goal' || !exec.agent || ctx.goals.get(exec.agent)
      || !sourceProjects(ctx, exec.agent.id).direct) return next()
    throw new Error('Project goals use wud_enter and wud_submit_plan. Await the owner’s signed plan before executing.')
  })
  ctx.commands.register({
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-goal'),
    name: 'goal',
    description: '在项目对话中设置或查看目标',
    input: { hint: '[<目标>|clear|edit <目标>|pause|resume]', attachments: true },
    async handler(invocation) {
      const { agent, commandId, attachments, signal } = invocation
      const project = sourceProjects(ctx, agent.id).direct
      if (!project || ctx.goals.get(agent)) return executeGoalCommand(ctx, invocation)
      try {
        const input = invocation.rawInput.trim()
        const current = ctx.taskController.currentGoal(project.id, agent.id)
        const control = { clear: 'exit', pause: 'pause', resume: 'resume' }[input.toLowerCase()]
        const edit = /^edit(?:\s|$)/iu.test(input)
        const objective = edit ? input.slice(4).trim() : input
        if (attachments.length && (!objective || control))
          return { kind: 'error', text: '请将附件随目标正文一起发送。' }
        let state = current
        if (control) {
          if (!current) return { kind: 'error', text: '当前对话没有目标。' }
          state = await ctx.taskController.controlGoal(project.id, agent.id, current.id, {
            requestId: commandId, action: control, revision: current.controlRevision ?? 0,
          }, signal)
        } else if (edit && !objective) {
          return { kind: 'error', text: '请输入修改后的目标。' }
        } else if (objective) {
          const active = current && current.phase !== 'EXITED'
          if (active && !edit)
            return { kind: 'error', text: '此对话已有目标。用 /goal edit 更新，或用 /goal clear 结束。' }
          if (!active && edit) return { kind: 'error', text: '当前对话没有可修改的目标。' }
          if (!active) state = await ctx.taskController.enterGoal(project.id, {
            requestId: commandId, sourceSessionId: agent.id, goal: objective,
          }, signal)
          agent.followup(createUserMessage({
            source: { kind: 'user' },
            content: [...attachments, { type: 'text', text: active
              ? '请按这个目标修订计划，提交给我重新审批。\n\n' + objective : objective }],
          }))
        }
        return { kind: 'success', text: state ? state.goal + '\n\n' + state.phase : '当前对话没有目标。' }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}
