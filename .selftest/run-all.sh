#!/usr/bin/env bash
# 值班模板功能自测入口：node .selftest/run-all.sh
set -u
cd "$(dirname "$0")/.."
echo "########## 模型/单元测试 ##########"
node .selftest/test-model.js || exit 1
echo
echo "########## 集成测试 ##########"
node .selftest/test-integration.js || exit 1
echo
echo "########## 排班日分组测试 ##########"
node .selftest/test-layout.js || exit 1
