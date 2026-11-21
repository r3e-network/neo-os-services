/**
 * Ambient declarations for workflow-catalog.js (JS module without an
 * upstream .d.ts). Keep in sync with vendor/neo-shared/src/workflow-catalog.js.
 */
export declare const RESULT_ENVELOPE_VERSION: string;

export declare const PUBLIC_RUNTIME_TOPOLOGY: Readonly<{
  ingressPlane: string;
  orchestrationPlane: string;
  schedulerPlane: string;
  executionPlane: string;
  riskPlane: string;
}>;

export declare const PUBLIC_RISK_ACTIONS: readonly string[];

export interface WorkflowDefinition {
  id: string;
  version: number;
  trigger: { kind: string };
  allowedNetworks: string[];
  route: string;
  capabilityId: string;
  [key: string]: unknown;
}

export declare function listWorkflowDefinitions(): readonly WorkflowDefinition[];

export declare function getWorkflowDefinition(
  id: string,
): WorkflowDefinition | undefined;
