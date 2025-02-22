/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */
const customWebpack = require("../webpack.config.cjs");
const webpackRules = customWebpack({ production: true }).module.rules;

module.exports = {
	stories: ["../src/**/*.stories.mdx", "../src/**/*.stories.@(js|jsx|ts|tsx)"],
	staticDirs: ["../assets"],
	addons: ["@storybook/addon-links", "@storybook/addon-essentials"],
	framework: "@storybook/react",
	core: {
		builder: "@storybook/builder-webpack5",
	},
	webpackFinal: (config) => {
		return { ...config, module: { ...config.module, rules: webpackRules } };
	},
};
