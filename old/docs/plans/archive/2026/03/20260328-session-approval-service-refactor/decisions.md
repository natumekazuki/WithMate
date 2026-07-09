# Decisions

- pending approval state は `SessionObservabilityService` に混ぜず、`SessionApprovalService` として別 service に切る
- live run への `approvalRequest` 投影は `SessionApprovalService` から `SessionObservabilityService.updateLiveSessionRun()` を呼んで同期する
