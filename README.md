# GPU Server Monitor · 服务器监控

**English summary:** a VS Code extension that monitors the machine your window is connected to (Remote-SSH, WSL, Tunnel, Dev Containers or local): CPU, NVIDIA GPUs, memory, disks, network, processes, tmux sessions, listening ports, per-user usage, Docker containers and folder sizes, plus watches (process exit, tmux job done, GPUs free) and memory/disk alerts. It runs on the remote host (`extensionKind: workspace`), reads `/proc` directly, keeps a single streaming `nvidia-smi`, only polls views that are visible, and slows down or pauses when the window is unfocused. Linux hosts are fully supported. The UI is localized in English and Simplified Chinese.

---

在 VS Code 的侧边栏和状态栏中查看**当前连接的机器**（Remote-SSH、WSL、隧道、开发容器或本机）的运行状况，适合多人共用的 GPU 服务器。

## 安装

- 在 VS Code 扩展视图中搜索 **GPU Server Monitor**，或按 `Ctrl+P` 输入 `ext install clorf6.gpu-server-monitor`。
- 扩展运行在**被监控的机器**上：在 Remote-SSH / WSL / 隧道 / 容器窗口中，点击扩展页上的“在 SSH: xxx 中安装”（或“在 WSL 中安装”），每台主机装一次。
- 想让每台 SSH 主机自动装上，在用户设置中加入：

  ```json
  "remote.SSH.defaultExtensions": ["clorf6.gpu-server-monitor"]
  ```

## 功能

**状态栏**：一行显示 CPU、内存、空闲 GPU 数、网速等（可配置）；悬停显示完整概览（主机、负载、内存/交换区、网络与磁盘 IO、最忙的磁盘、I/O 等待、停顿压力、CPU 温度、主目录磁盘、每块 GPU 的利用率/显存/温度/功耗），单击打开仪表板。内存或主目录磁盘接近用满时变黄/变红。

**侧边栏面板**（活动栏中的“服务器监控”）：顶部的“监控 / 算力 / 工具”分段按钮和下方的页签用来切换页面，每个新窗口默认打开“监控 › 概览”。

| 页面 | 内容与操作 |
|---|---|
| **监控 › 概览** | 需要注意的情况，可定位或忽略：自己的高占用进程、快满或过热的 GPU、内存 / 交换区、**内存或磁盘 I/O 停顿压力**、**内核因内存不足结束进程**、**CPU / 磁盘过热**、相关磁盘快满、**按当前速度多久写满**、**inode 快用完**、**GPU 显存错误 / PCIe 降级 / 过热降频**、**GPU 闲置却仍占着显存**（自己的单独提醒，其他用户的合并为一条）、无响应的挂载点、僵尸 / 暂停的进程。卡片：CPU（用户 / 系统 / I/O 等待、温度）、内存（交换区和换页速度）、GPU、主目录磁盘、**磁盘 I/O**（最忙磁盘的繁忙度、读写、每次请求耗时、IOPS）、网络、运行时间；CPU、内存、磁盘 I/O 卡片右上角显示**停顿压力**（最近 10 秒任务等待该资源的时间比例）。随负载变化的像素猫；“智能释放”。在其他页面时，提醒数量显示在“监控”按钮上。 |
| **监控 › 进程** | 默认只看自己的进程，可切换到所有用户；搜索命令、PID 或 `user:名字`；按 CPU / 内存 / 显存 / **磁盘 I/O** / 启动时间排序；自己的进程显示当前读写速度。点选进程：结束时提醒、在工作目录打开终端、复制 PID / 命令；自己的进程还可以中断 / 结束 / 强制结束（结束前会确认）。 |
| **监控 › 端口** | 我的监听端口：在浏览器或编辑器中打开（远程窗口自动走 VS Code 端口转发）、复制 URL、结束监听进程；其他用户的端口可展开查看。 |
| **监控 › 磁盘** | **每块物理磁盘**的繁忙度、读写速度、IOPS、每次请求耗时和温度，以及上面有哪些挂载点；各挂载点使用率（主目录在前、网络文件系统在后）、**inode 使用率**、所在磁盘，正在变满时显示**按当前速度多久写满**；网络文件系统卡住时标记“无响应”。分析大小、在此打开终端、复制路径。 |
| **算力 › GPU** | 每块 GPU 的利用率、显存、温度、功耗、核心频率、PCIe 链路和使用者，以及**降频原因**（功耗墙 / 过热 / 硬件）、**ECC 显存错误**、**PCIe 降级**、**闲置多久仍占着多少显存**；勾选 GPU（默认是所有空闲 GPU）后复制或在终端中 `export CUDA_VISIBLE_DEVICES`，或在 GPU 空闲时提醒。 |
| **算力 › 用户** | 按用户汇总 CPU、内存、所用 GPU、显存与进程数（你自己会高亮）；点击用户查看其进程。 |
| **算力 › tmux** | 会话 → 窗口 → 窗格，标出正在运行命令的窗格。附加、预览输出（只读编辑器，自动刷新）、命令结束时提醒、发送 Ctrl-C、重命名、结束、新建会话。 |
| **工具 › 常用** | 仪表板、智能释放、选择 GPU、GPU 空闲提醒、新建 tmux 会话、分析文件夹大小、刷新、设置，以及可自定义的快捷命令。 |
| **工具 › 文件夹** | 类似 ncdu：逐层用 `du` 统计（后台子进程，不跨文件系统，可并行、可取消），点击文件夹进入、点击路径返回上层，最近使用的文件夹和常用位置。也可在资源管理器中右键文件夹使用。 |
| **工具 › 提醒** | 当前所有监视项（进程退出、tmux 命令结束、GPU 空闲），完成时弹出通知；窗口在后台时仍继续运行，按主机保存。 |
| **工具 › Docker** | 检测到 Docker 套接字时出现：容器状态、镜像、端口；启动 / 停止 / 重启、查看日志、在容器中打开 Shell、复制 ID。 |

只有当前显示的页面会采集它需要的额外数据（端口、tmux、Docker、所有用户的进程），切换页面或隐藏面板后立即停止。需要原来带右键菜单的树形视图时，打开设置 `serverMonitor.sidebar.showTreeViews`，它们会显示在面板下方。

**仪表板**（命令“服务器监控: 打开仪表板”或单击状态栏）：CPU、内存、网络、GPU 的历史曲线，保留时长见 `serverMonitor.history.minutes`。

**告警**：内存或与你相关的磁盘（主目录所在盘、当前工作区所在盘、以及根目录下有以你用户名命名文件夹的盘）使用率超过阈值时弹出一次警告（带回差，避免反复提醒），可对某台机器 / 某个磁盘选择“不再提醒”。

## 低开销是怎么做到的

- **直接读 `/proc`**：CPU、内存、网络、磁盘 IO、停顿压力（`/proc/pressure`）、换页和 OOM 计数（`/proc/vmstat`）每次只读几个小文件，不启动任何子进程；温度从 `/sys/class/hwmon` 读取，最多每 5 秒一次；GPU 健康信息（降频原因、频率、PCIe、ECC）随常驻的 `nvidia-smi` 一起查询，不额外启动进程（旧驱动不支持这些字段时自动省略）；进程扫描使用同步读取 + 分批让出事件循环，“只看我的进程”时还会缓存 uid、隔一轮才发现新进程。
- **nvidia-smi 常驻流式模式**：只启动一个长期运行的 `nvidia-smi -lms`，NVML 只初始化一次，而不是每次采样都付出约 150 ms 的启动开销；流异常时自动退回单次查询。
- **只为可见的视图采集**：每个数据源只有在被需要时（视图可见、状态栏、监视项）才运行；折叠或隐藏的视图完全不采集。端口列表使用 `ss`（netlink），开销远低于读取 `/proc/net/tcp6`。
- **窗口失焦时降频或暂停**：按 `serverMonitor.backgroundMode` 降到后台间隔或完全暂停；监视项和告警始终以后台间隔运行。
- **防 NFS 卡死**：网络文件系统在独立子进程中带超时查询，不响应时标记“无响应”并以退避方式重试，扩展主机不会被挂住。
- 轮询不会重叠：上一次采集结束后才安排下一次，慢的采集器不会堆积任务。

## 设置

| 设置 | 默认值 | 说明 |
|---|---|---|
| `serverMonitor.refreshInterval` | `2000` | 窗口有焦点时 CPU / 内存 / 网络 / GPU 的刷新间隔（毫秒，最小 500）。进程、端口、tmux、磁盘有各自更长的固定间隔。 |
| `serverMonitor.backgroundMode` | `slow` | 窗口失焦时：`slow` 按后台间隔继续刷新；`pause` 暂停视图和状态栏。监视项和告警不受影响。 |
| `serverMonitor.backgroundInterval` | `15000` | 后台刷新间隔（毫秒，最小 2000），监视项和告警也使用它。 |
| `serverMonitor.sidebar.showTreeViews` | `false` | 在侧边栏面板下方同时显示经典的树形视图（带右键菜单）。 |
| `serverMonitor.statusBar.enabled` | `true` | 是否显示状态栏项。 |
| `serverMonitor.statusBar.items` | `["cpu","mem","gpu","net"]` | 状态栏显示的指标及顺序，可选 `cpu`、`mem`、`gpu`、`gpuMem`、`net`、`load`、`disk`、`io`（最忙磁盘的繁忙度）。 |
| `serverMonitor.statusBar.warnPercent` | `85` | 内存或主目录磁盘达到此百分比时状态栏变黄。 |
| `serverMonitor.statusBar.critPercent` | `95` | 达到此百分比时状态栏变红。 |
| `serverMonitor.gpu.freeUtilPercent` | `5` | 利用率低于此值（%）、且卡上没有计算进程的 GPU 视为空闲；桌面 / 浏览器占用的显存（不超过三分之一）不算占用。 |
| `serverMonitor.gpu.idleHoldMinutes` | `30` | GPU 闲置（利用率低于空闲阈值）超过这么多分钟、却仍有进程占着至少 1 GiB 显存时提醒；`0` 关闭。 |
| `serverMonitor.gpu.freeMemoryMiB` | `500` | 无法得知卡上进程时（例如进程列表尚未加载），显存占用低于此值（MiB）才算空闲；WSL 中按此值与三分之一显存中的较大者判断。 |
| `serverMonitor.alerts.enabled` | `true` | 是否启用内存 / 磁盘告警。 |
| `serverMonitor.alerts.memoryPercent` | `90` | 内存告警阈值（%）。 |
| `serverMonitor.alerts.diskPercent` | `95` | 磁盘告警阈值（%）。 |
| `serverMonitor.processes.defaultScope` | `mine` | “进程”页面默认显示 `mine`（自己的）或 `all`（所有用户）。 |
| `serverMonitor.processes.limit` | `50` | 最多列出的进程数（最小 5），其余折叠为“还有 N 个…”。 |
| `serverMonitor.disk.excludeFsTypes` | `[]` | 额外隐藏的文件系统类型，如 `nfs4`。 |
| `serverMonitor.disk.excludeMounts` | `[]` | 隐藏的挂载点（含其下所有挂载），如 `/mnt/archive`。 |
| `serverMonitor.disk.networkTimeoutMs` | `3000` | 网络文件系统查询超时（毫秒，最小 500）。 |
| `serverMonitor.docker.enabled` | `true` | 是否显示 Docker 视图。 |
| `serverMonitor.history.minutes` | `10` | 仪表板保留的历史时长（1–60 分钟）。 |

## 构建与安装

需要 Node.js 18 及以上版本。

```bash
npm install
npm run package        # 类型检查 + 打包，生成 gpu-server-monitor-<版本>.vsix
```

手动安装 `.vsix`：扩展视图 → 右上角 `…` → “从 VSIX 安装…”；或 `code --install-extension gpu-server-monitor-<版本>.vsix`。在远程窗口中操作时会安装到**远程主机**上。

开发：`npm run watch` 持续构建，`npm test` 运行解析器测试，`npm run test:host` 用本机真实数据检查侧边栏面板各页面申请 / 释放的数据源，`node scripts/check-manifest.mjs` 检查命令、菜单与翻译是否一致。

## 限制

- **Linux 主机功能完整**。在 macOS / Windows 本机窗口中只有 CPU、内存和 GPU（不含网络与磁盘速率、进程、端口、磁盘列表和文件夹大小）。
- **WSL** 中的 `nvidia-smi` 无法列出各进程的显存占用，因此 GPU 视图不显示占用进程。
- 非 root 用户无法解析**其他用户**监听端口所属的进程，只显示用户名。
- **Docker** 视图需要对 Docker 套接字有读写权限（通常需加入 `docker` 用户组）；“查看日志”和“打开 Shell”还需要 `docker` 命令行。
- 只支持 NVIDIA GPU（通过 `nvidia-smi`）。
