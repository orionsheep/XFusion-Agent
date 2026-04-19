package xfusion.authz

default decision := {
  "allowed": false,
  "risk_level": "L4",
  "approval_required": false,
  "reason": "blocked by default",
  "blast_radius": {"hosts": 1, "services": 1, "paths": []},
}

read_actions := {
  "query_disk",
  "search_files",
  "check_port",
  "query_process",
  "discover_services",
  "diagnose_service",
}

approval_actions := {
  "create_linux_user",
  "delete_linux_user",
  "restart_service",
  "kill_process",
}

blocked_actions := {
  "delete_path",
  "modify_security_config",
  "bulk_permission_change",
}

path_scope := object.get(input.parameters, "path", "")

decision := {
  "allowed": true,
  "risk_level": risk,
  "approval_required": false,
  "reason": reason,
  "blast_radius": {"hosts": 1, "services": 1, "paths": [path_scope]},
} if {
  input.action_type in read_actions
  risk := "L0"
  reason := "read-only or diagnostic action"
}

decision := {
  "allowed": true,
  "risk_level": "L3",
  "approval_required": true,
  "reason": "state-changing action requires approval",
  "blast_radius": {"hosts": 1, "services": 1, "paths": [path_scope]},
} if {
  input.action_type in approval_actions
}

decision := {
  "allowed": false,
  "risk_level": "L4",
  "approval_required": false,
  "reason": "dangerous action blocked by policy",
  "blast_radius": {"hosts": 1, "services": 1, "paths": [path_scope]},
} if {
  input.action_type in blocked_actions
}
