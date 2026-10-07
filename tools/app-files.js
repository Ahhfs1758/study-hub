'use strict';
/**
 * app-files.js —— 「打包要打哪些文件」的唯一真值
 *
 * 单独放一个模块，而不是定义在 make-app.js 里：
 * make-app 与 check-bundle 都要用这份清单（一个负责打包、一个负责校验），
 * 而 check-bundle 又会被 make-app 在打包末尾调用 —— 如果清单定义在 make-app 里，
 * 两者就形成循环依赖：check-bundle 拿到的会是**还没填好的空导出对象**，
 * `.INCLUDE` 为 undefined，接着在打包中途崩掉（看起来像打包脚本坏了）。
 * 抽成叶子模块后依赖方向是单向的，不会再出现这种问题。
 */

/** 需要打进包里的顶层条目（文件或目录），相对项目根 */
const INCLUDE = [
  'main.js',
  'preload.js',
  'package.json',
  'src/main',
  'src/renderer',
  'src/shared',
  'src/daemon',
  'assets'
];

/** 明确不该出现在包里的目录名（开发产物、示例数据、依赖） */
const EXCLUDE_NAMES = new Set([
  '.selftest', 'release', 'node_modules', '.git',
  'tools', 'backups', 'vault', 'tests'
]);

module.exports = { INCLUDE, EXCLUDE_NAMES };
