package xfusion.authz

default allow := false
default approval_required := false
default reason := "blocked by default"

read_actions := {"query_disk", "check_port", "query_process", "discover_services"}
approval_actions := {"create_linux_user", "delete_linux_user", "restart_service"}
blocked_actions := {"delete_path", "modify_sshd_config", "bulk_permission_change"}

allow if {
  input.action_type in read_actions
}

allow if {
  input.action_type in approval_actions
}

approval_required if {
  input.action_type in approval_actions
}

reason := "dangerous action blocked" if {
  input.action_type in blocked_actions
}
