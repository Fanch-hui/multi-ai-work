---
name: wave2-tech-python
description: "用明确类型、标准库和可执行测试实现计算、文件与接口逻辑。"
license: MIT
---

# Python可靠实现

用明确类型、标准库和可执行测试实现计算、文件与接口逻辑。

## 岗位流程

1. 检查输入、现有 Python 版本和依赖，优先使用 pathlib、csv、json、decimal、sqlite3、unittest 等标准库完成独立任务。
2. 公共函数标注类型，明确返回值与业务异常；资源用上下文管理，避免共享可变默认参数。
3. 用真实样例和错误输入测试行为；项目已有 pytest/mypy 时沿用，未安装时采用 unittest、doctest 或编译检查，不声称未运行的类型检查通过。
4. 金额用分或 Decimal，处理文本指定 UTF-8，按需要记录空值与异常。
5. 交付源文件、运行入口、结果与复现命令。

## App 工作方式

先读取本技能，再按任务需要用 read_file 读取技能目录内的上游工作流及参考；只使用当前任务已授权文件和连接。需要计算或执行时先调用 load_workspace_dependencies，使用返回的 Python / Node 可执行文件绝对路径，路径含空格时正确引用；run_command 在任务工作目录运行。命令执行与安装依赖均遵守当前权限，缺失依赖明确提出，不自动安装、下载或调用真实发布服务。

中文交付可复用文件、必要测试或计算脚本、实际结果和简短说明；使用 App 成果工具登记最终文件。原始输入另存保留，修改项目先理解现有结构与调用关系，不覆盖与任务无关的文件。只报告实际执行的检查、退出结果和已生成文件，尚未完成的检查写明具体待办。测试当前工作所需的正常路径和实际错误，不以模拟工具调用次数替代业务结果。


软件任务根据现有项目选择技术栈，最小项目可用随包 Python/Node 标准库；上游 React、Next、pytest、Docker 等是按项目选择的方案，不要求安装新框架。测试按风险覆盖真实输入输出，修复需对比问题重现与修改后结果。未经任务明确要求不自动操作浏览器页面；静态结构、纯业务逻辑和命令检查分别记录，页面实际交互由用户确认。

## 按需参考

- `upstream/skills/python-pro/SKILL.md`：固定上游完整工作流。
- `upstream/skills/python-pro/references/standard-library.md`
- `upstream/skills/python-pro/references/testing.md`

参考中的命令、框架和外部连接名需映射为当前项目与 App 实际能力，不执行自动安装或扩大权限。署名与分发许可见 LICENSE / NOTICE。
