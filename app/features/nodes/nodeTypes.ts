export type NodeData = {
  name: string;
  label: string;
  online: boolean;
  checkedAt: number;
  platform?: string;
  connectionError?: string;
  manual?: boolean;
  owner?: string;
  canModify?: boolean;
};
