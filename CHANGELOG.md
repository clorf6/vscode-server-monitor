# 更新日志 / Changelog

## 0.3.2

- 首次发布到 VS Code 插件市场（`clorf6.gpu-server-monitor`，英文名 GPU Server Monitor）。从 `.vsix` 手动安装过的旧版本（`local.server-monitor`）请先卸载。
- 新图标、MIT 许可证；README 增加安装说明。

---

- First Marketplace release as `clorf6.gpu-server-monitor` ("GPU Server Monitor"). Uninstall the manually installed `local.server-monitor` first.

## 0.3.1

- 修复：WSL / 桌面电脑上 GPU 明明空闲却显示“0/1 空闲”、服务器猫显示“GPU 都被占满了”。空闲判定改为：利用率低且卡上没有计算进程；桌面和浏览器占用的显存（不超过三分之一）不再算作占用。WSL 无法列出进程时按同样的显存比例判断。
- 服务器猫只有在每张 GPU 都真正满载（利用率 ≥ 80% 或显存 ≥ 90%）时才显示“GPU 都被占满了”。

---

- Fix: an idle GPU on WSL/desktop machines was reported as busy because the display uses some GPU memory; the mood cat now says "GPUs are full" only when every GPU is saturated.

## 0.3.0

- 侧边栏改为一个面板，不再上下堆叠多个分栏：顶部「监控 / 算力 / 工具」分段按钮加下划线页签切换页面。每个新窗口默认打开「监控 › 概览」；同一窗口内隐藏后再显示，仍停留在原来的页面。
- 监控：**概览**（提醒卡片只在这里显示，其他页面在「监控」按钮上显示数量角标）、**进程**（我的 / 所有用户，搜索命令、PID 或 `user:用户名`，按 CPU / 内存 / 显存 / 启动时间排序；点选进程后可设置结束提醒、在工作目录打开终端、复制 PID / 命令，对自己的进程中断 / 结束 / 强制结束）、**端口**（在浏览器或编辑器中打开、复制 URL、结束进程；其他用户的端口可展开查看）、**磁盘**（使用率条、读写速率、无响应标记；分析大小、在此打开终端、复制路径）。
- 算力：**GPU**、**用户**（每个用户的 CPU、内存、所用 GPU、显存和进程数，点击查看其进程）、**tmux**（会话 → 窗口 → 窗格，标出正在运行的命令；附加、预览、命令结束时提醒、发送 Ctrl-C、重命名、结束、新建会话）。
- 工具：**常用**、**文件夹**（面板内的 ncdu 式浏览：可点击的路径、上一级、重新扫描 / 取消、最近使用的文件夹和常用位置，多个文件夹可并行扫描）、**提醒**（当前监视项、GPU 空闲提醒）、**Docker**（检测到 Docker 时出现：启动 / 停止 / 重启、日志、Shell、复制 ID）。
- 原来的树形视图默认隐藏，新设置 `serverMonitor.sidebar.showTreeViews` 可重新显示（右键菜单照旧）。「定位」、资源管理器中的「分析文件夹大小」、仪表板的「打开进程」、「查看该用户的进程」现在都跳转到面板中的对应页面。
- 开销：面板可见时只保持概览本身需要的数据源；端口、tmux、Docker 以及所有用户的进程只在对应页面打开时采集，切换页面或隐藏面板后立即释放；只发送当前页面的数据，每个进程的命令行只发送一次，其他用户的端口展开后才发送。
- 侧边栏视图改名为「控制台」。

---

- The sidebar is now a single panel with page navigation (Monitor / Compute / Tools segments and page tabs) instead of stacked views, and new windows open on Monitor › Overview. New in-panel pages: Processes, Ports, Disks, Users, tmux, Folders, Alerts and Docker. The classic tree views are hidden by default (`serverMonitor.sidebar.showTreeViews`). Data a page needs is collected only while that page is shown.

## 0.2.0

- 侧边栏新增「概览」面板：提醒卡片（可定位 / 关闭）、CPU / 内存 / GPU / 磁盘 / 网络 / 运行时间卡片（进度条 + 迷你曲线）、随负载变化的像素猫；「算力」页可勾选 GPU 复制或 export `CUDA_VISIBLE_DEVICES`；「工具」页提供常用操作与可自定义的快捷命令。
- 智能释放：列出自己可回收的空闲进程（空占显存、被暂停、空闲 Jupyter 内核、长时间空闲的大内存进程），确认后结束；不碰正在工作的任务，不使用 sudo。
- 文件夹大小：新的文件夹选择器（输入路径并补全子文件夹、最近 / 主目录 / 工作区 / 挂载点）、上一级、多个文件夹并行扫描。
- 体验：各视图加载提示、磁盘按主目录 / 本地 / 网络排序、tmux 预览自动跟随最新输出、状态栏提示中加入智能释放。
- 性能：GPU 进程改为常驻流式查询、状态栏单独显示时 5 秒刷新、`/proc` 列表共享且不阻塞事件循环、`ss` 仅在需要时解析属主、相同数据不重复刷新、首次出数更快（约 0.3 秒）；只开状态栏时开销从约 1.3% 降到约 0.4% 单核（含子进程）。
- 修复：切换进程范围后 CPU% 计算错误；NFS 卡住时 `stat` 子进程堆积；网络盘上的同步文件访问可能卡住扩展。

---

- New sidebar Overview (attention cards, stat cards with sparklines, mood cat, GPU picker, tools & quick commands), Free Up Resources, a folder chooser for Folder Sizes, and a performance pass (status bar alone ≈0.4% of one core including child processes).

## 0.1.0

首个版本 / Initial release.

- 状态栏概览（CPU、内存、GPU、显存、网络、负载、磁盘，可配置），悬停查看完整摘要，单击打开仪表板。
- 视图：GPU、进程、tmux、监听端口、磁盘、用户、Docker、文件夹大小、监视与提醒。
- GPU：空闲判定、复制 / 在终端中导出 `CUDA_VISIBLE_DEVICES`、GPU 空闲时通知。
- 进程：自己的 / 所有用户、排序、树形、筛选、终止 / 强制结束、进程退出时通知。
- tmux：预览输出、在终端中附加、新建 / 重命名 / 终止、发送 Ctrl-C、命令结束时通知。
- 内存与磁盘使用率告警，可按机器 / 磁盘静音。
- 低开销：直接读取 `/proc`、常驻流式 `nvidia-smi`、只为可见视图采集、失焦时降频或暂停、网络文件系统超时保护。
- 界面支持英文与简体中文。

---

- Status bar summary (CPU, memory, GPUs, GPU memory, network, load, disk; configurable) with a full tooltip; click to open the dashboard.
- Views: GPUs, Processes, tmux, Listening Ports, Disks, Users, Docker, Folder Sizes, Watches & Alerts.
- Watches for process exit, tmux job completion and free GPUs; memory and disk threshold alerts.
- Low overhead: reads `/proc` directly, one streaming `nvidia-smi`, polls only visible views, slows down or pauses when unfocused, hung-NFS protection.
- English and Simplified Chinese UI.
