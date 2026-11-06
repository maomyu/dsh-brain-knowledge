import { ToolsService } from '../../vendor/dao-runtime/tools.js'
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native'

export default class BrainTools extends ToolsService {
  setExecutor(executor) {
    if (executor.nativeFallback || executor instanceof NativeToolExecutor) return super.setExecutor(executor)
    const native = new NativeToolExecutor(this.ctx)
    const routed = {
      sections: executor.sections,
      describe: executor.describe.bind(executor),
      execute: executor.execute.bind(executor),
      nativeFallback: native,
    }
    return super.setExecutor(routed)
  }
}
