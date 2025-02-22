/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

/**
 * This library contains a simple React-based visualizer for the Fluid Devtools.
 *
 * @remarks
 *
 * The entry-point to this package is {@link DevtoolsPanel}, a {@link https://react.dev/reference/react/Component | React Component}
 * for displaying debug information, which can be added to your Fluid-backed React app.
 *
 * @privateRemarks TODO: Add examples once the API surface has solidified.
 *
 * @packageDocumentation
 */

export type { DevtoolsPanelProps } from "./DevtoolsPanel";
export { DevtoolsPanel } from "./DevtoolsPanel";
export { WindowMessageRelay } from "./WindowMessageRelay";
export { isTelemetryOptInEnabled } from "./TelemetryUtils";

// Convenience re-exports
export type { IMessageRelay } from "@fluidframework/devtools-core";
export type { ITelemetryBaseEvent, ITelemetryBaseLogger } from "@fluidframework/core-interfaces";
