export type NodeProbeState = {
  online: boolean;
  checkedAt: number;
  platform: string | null;
  connectionError: string | null;
};

export type NodeStatus = NodeProbeState & {
  name: string;
  label: string;
  owner: string;
  canModify: boolean;
  manual: boolean;
};
