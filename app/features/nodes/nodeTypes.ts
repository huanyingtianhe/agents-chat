export type NodeData = {
  name: string;
  label: string;
  online: boolean;
  checkedAt: number;
  manual?: boolean;
  owner?: string;
  canModify?: boolean;
};
