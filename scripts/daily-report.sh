#!/usr/bin/env bash
# feishu-pi-bridge daily-report 定时任务包装脚本
#
# crontab 用法（早 8 晚 8）：
#   0 8,20 * * * /home/childelins/code/projects/feishu-pi-bridge/scripts/daily-report.sh >> /tmp/feishu-daily-report.log 2>&1
#
# 默认每次以全新 pi 会话生成日报（清理 feishu-daily-report-bot 的历史 session，
# 避免旧日报上下文污染当天输出）。额外参数透传给 node：
#   --keep-session   保留并复用历史 session（仅调试用）
#   --model=<arg>    指定生成日报所用模型（测试用）。语义同飞书 /model：
#                    数字按 .env FEISHU_MODEL_MAP 映射（如 --model=2）；
#                    含 "/" 的串视为 provider/model（如 --model=Tencent/deepseek-v4-pro-202606）；
#                    其它串按 model id（如 --model=glm-4.6）。
#                    --model=0 / reset / default = 用默认 PI_MODEL（等同不带此参数）。
#                    当前可用编号见 .env 的 FEISHU_MODEL_MAP（示例：1=NewAPI/glm-5.2,2=...,3=...），
#                    无效编号会报错并使本次运行失败退出。
#
# 这个脚本封装 cron 环境天然缺失的两样东西：
#   1. nvm 管理的 node/pnpm 不在 cron 的默认 PATH 里
#   2. cron 不 source 任何 shell 配置，没有 https_proxy——而 Pi 调 aihot/tavily/github
#      在国内必须走代理（直连会被立即拒绝）。漏掉这个会导致日报里数据源全部失败。
# 飞书凭证（FEISHU_APP_ID/SECRET、FEISHU_DAILY_REPORT_CHAT_ID）由 bridge 的 loadEnvFile
# 从项目 .env 读取，不用在这里设。

set -euo pipefail

PROJECT_DIR=/home/childelins/code/projects/feishu-pi-bridge
cd "$PROJECT_DIR"

# 1. nvm 的 node 绝对路径（cron 默认 PATH 找不到）
export PATH="/home/childelins/.nvm/versions/node/v24.11.1/bin:$PATH"

# 2. 外网代理（WSL2 → Windows 代理）。端口变了就改这里。
PROXY=http://127.0.0.1:17890
export http_proxy="$PROXY"
export https_proxy="$PROXY"
export HTTP_PROXY="$PROXY"
export HTTPS_PROXY="$PROXY"
export no_proxy="localhost,127.0.0.1,::1,10.*,172.16.*,172.17.*,172.18.*,172.19.*,172.20.*,172.21.*,172.22.*,172.23.*,172.24.*,172.25.*,172.26.*,172.27.*,172.28.*,172.29.*,172.30.*,172.31.*,192.168.*"
export NO_PROXY="$no_proxy"

echo "[$(date '+%F %T')] daily-report start (proxy=$PROXY)"
if node dist/index.js daily-report "$@"; then
  echo "[$(date '+%F %T')] daily-report OK"
else
  echo "[$(date '+%F %T')] daily-report FAILED exit=$?"
fi
