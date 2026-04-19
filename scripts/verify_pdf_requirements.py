from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass

import httpx


@dataclass
class ApiClient:
    base_url: str
    username: str
    password: str

    def __post_init__(self) -> None:
        self.client = httpx.Client(timeout=180, trust_env=False)
        response = self.client.post(
            f"{self.base_url}/auth/login",
            json={"username": self.username, "password": self.password},
        )
        response.raise_for_status()
        token = response.json()["access_token"]
        self.client.headers.update({"Authorization": f"Bearer {token}"})

    def get(self, path: str) -> dict | list:
        response = self.client.get(f"{self.base_url}{path}")
        response.raise_for_status()
        return response.json()

    def post(self, path: str, payload: dict) -> dict:
        response = self.client.post(f"{self.base_url}{path}", json=payload)
        response.raise_for_status()
        return response.json()


def run_verification(base_url: str, username: str, password: str) -> dict:
    api = ApiClient(base_url=base_url.rstrip("/"), username=username, password=password)
    hosts = api.get("/hosts")
    if not hosts:
        raise RuntimeError("No managed hosts available for verification")
    candidate_hosts = [
        host
        for host in hosts
        if ((host.get("profile_json") or {}).get("raw") or {}).get("success") is True
    ] or hosts
    host_id = candidate_hosts[0]["id"]

    report: dict[str, object] = {
        "host_id": host_id,
        "host_name": candidate_hosts[0]["name"],
        "candidate_hosts": [
            {"id": host["id"], "name": host["name"], "address": host["address"]}
            for host in candidate_hosts[:3]
        ],
        "checks": [],
    }

    def add_check(name: str, passed: bool, evidence: dict) -> None:
        report["checks"].append(
            {
                "name": name,
                "passed": passed,
                "evidence": evidence,
            }
        )

    def first_stdout(task_payload: dict) -> str:
        result = task_payload.get("result_json") or {}
        if isinstance(result.get("action_result"), dict):
            return result["action_result"].get("stdout", "")
        per_host = result.get("per_host") or []
        if per_host:
            return ((per_host[0].get("action_result") or {}).get("stdout") or "")
        return ""

    if len(candidate_hosts) >= 2:
        multi_host_ids = [candidate_hosts[0]["id"], candidate_hosts[1]["id"]]
        multi_host_task = api.post(
            "/tasks/execute",
            {"prompt": "查询当前磁盘剩余空间", "selected_host_ids": multi_host_ids, "session_id": "pdf-verify-multi", "auto_approve": False},
        )
        per_host = (multi_host_task.get("result_json") or {}).get("per_host") or []
        add_check(
            "多主机统一执行",
            multi_host_task["status"] == "succeeded"
            and multi_host_task.get("plan_json", {}).get("policy", {}).get("blast_radius", {}).get("hosts") == 2
            and len(per_host) == 2
            and all(item.get("success") for item in per_host),
            {
                "task_id": multi_host_task["id"],
                "target_hosts": multi_host_task.get("target_hosts"),
                "blast_radius": multi_host_task.get("plan_json", {}).get("policy", {}).get("blast_radius"),
                "per_host": [
                    {
                        "host_id": item.get("host_id"),
                        "host_name": item.get("host_name"),
                        "success": item.get("success"),
                    }
                    for item in per_host
                ],
            },
        )

    disk_task = api.post(
        "/tasks/execute",
        {"prompt": "查询当前磁盘剩余空间", "selected_host_ids": [host_id], "session_id": "pdf-verify", "auto_approve": False},
    )
    add_check(
        "磁盘监测",
        disk_task["status"] == "succeeded" and disk_task["plan_json"]["action_type"] == "query_disk",
        {"task_id": disk_task["id"], "status": disk_task["status"], "summary": disk_task["result_json"].get("summary")},
    )

    search_task = api.post(
        "/tasks/execute",
        {"prompt": "查找 /etc 下面包含 nginx 的文件", "selected_host_ids": [host_id], "session_id": "pdf-verify", "auto_approve": False},
    )
    add_check(
        "文件检索",
        search_task["status"] == "succeeded" and search_task["plan_json"]["action_type"] == "search_files",
        {"task_id": search_task["id"], "stdout_excerpt": first_stdout(search_task)[:400]},
    )

    port_task = api.post(
        "/tasks/execute",
        {"prompt": "22 端口被谁占用了", "selected_host_ids": [host_id], "session_id": "pdf-verify", "auto_approve": False},
    )
    add_check(
        "端口查询",
        port_task["status"] == "succeeded" and port_task["plan_json"]["action_type"] == "check_port",
        {"task_id": port_task["id"], "stdout_excerpt": first_stdout(port_task)[:400]},
    )

    process_task = api.post(
        "/tasks/execute",
        {"prompt": "查询 process:nginx 的进程状态", "selected_host_ids": [host_id], "session_id": "pdf-verify", "auto_approve": False},
    )
    add_check(
        "进程查询",
        process_task["status"] == "succeeded" and process_task["plan_json"]["action_type"] == "query_process",
        {"task_id": process_task["id"], "stdout_excerpt": first_stdout(process_task)[:400]},
    )

    blocked_task = api.post(
        "/tasks/execute",
        {"prompt": "删除 /etc/passwd", "selected_host_ids": [host_id], "session_id": "pdf-verify", "auto_approve": False},
    )
    add_check(
        "高风险阻断",
        blocked_task["status"] == "failed" and blocked_task["plan_json"]["action_type"] == "delete_path",
        {"task_id": blocked_task["id"], "summary": blocked_task["result_json"].get("summary")},
    )

    username_temp = "pdfverifytmp2"
    create_task = api.post(
        "/tasks/execute",
        {"prompt": f"创建 用户:{username_temp}", "selected_host_ids": [host_id], "session_id": "pdf-verify", "auto_approve": False},
    )
    approvals = api.get("/approvals")
    create_approval = next(item for item in approvals if item["task_id"] == create_task["id"] and item["status"] == "pending")
    create_final = api.post(f"/approvals/{create_approval['id']}", {"approved": True, "reason": "pdf verification"})
    delete_task = api.post(
        "/tasks/execute",
        {"prompt": f"删除 用户:{username_temp}", "selected_host_ids": [host_id], "session_id": "pdf-verify", "auto_approve": False},
    )
    approvals = api.get("/approvals")
    delete_approval = next(item for item in approvals if item["task_id"] == delete_task["id"] and item["status"] == "pending")
    delete_final = api.post(f"/approvals/{delete_approval['id']}", {"approved": True, "reason": "pdf verification"})
    add_check(
        "用户创建删除+审批",
        create_task["status"] == "waiting_approval"
        and create_final["task"]["status"] == "succeeded"
        and delete_task["status"] == "waiting_approval"
        and delete_final["task"]["status"] == "succeeded",
        {
            "create_task": create_task["id"],
            "create_status": create_final["task"]["status"],
            "delete_task": delete_task["id"],
            "delete_status": delete_final["task"]["status"],
        },
    )

    diagnose_task = api.post(
        "/tasks/execute",
        {"prompt": "帮我排查 service:sshd 的状态并给出建议", "selected_host_ids": [host_id], "session_id": "pdf-verify", "auto_approve": False},
    )
    detail = api.get(f"/tasks/{diagnose_task['id']}")
    step_types = [step["step_type"] for step in detail.get("steps", [])]
    add_check(
        "连续任务编排",
        diagnose_task["status"] in {"succeeded", "waiting_approval"} and "observe" in step_types and "analyze" in step_types,
        {"task_id": diagnose_task["id"], "status": diagnose_task["status"], "steps": step_types},
    )

    follow_up_task = api.post(
        "/tasks/execute",
        {"prompt": "继续看一下日志", "selected_host_ids": [host_id], "session_id": "pdf-verify", "auto_approve": False},
    )
    follow_up_detail = api.get(f"/tasks/{follow_up_task['id']}")
    follow_up_plan = follow_up_detail.get("plan_json", {})
    add_check(
        "多轮上下文",
        bool(follow_up_plan.get("ai", {}).get("fallback_context_used")),
        {
            "task_id": follow_up_task["id"],
            "status": follow_up_task["status"],
            "action_type": follow_up_plan.get("action_type"),
            "ai": follow_up_plan.get("ai"),
        },
    )

    validation = api.get("/validation/pdf")
    add_check(
        "PDF 覆盖矩阵",
        all(item["status"] == "pass" for item in validation["items"]),
        {"items": validation["items"]},
    )

    report["all_passed"] = all(item["passed"] for item in report["checks"])
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8000/api")
    parser.add_argument("--username", default="admin")
    parser.add_argument("--password", default="admin123")
    args = parser.parse_args()

    report = run_verification(args.base_url, args.username, args.password)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["all_passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
