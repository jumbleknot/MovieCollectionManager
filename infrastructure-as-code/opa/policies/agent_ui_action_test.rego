package mcm.agent_ui_action

import rego.v1

test_allow_navigate_collection_mc_user if {
    allow with input as {"action_type": "navigate", "target": "collection", "roles": ["mc-user"]}
}

test_admin_implies_user if {
    allow with input as {"action_type": "navigate", "target": "home", "roles": ["mc-admin"]}
}

test_allow_prefill_add_movie if {
    allow with input as {"action_type": "prefill", "target": "add-movie", "roles": ["mc-user"]}
}

test_deny_unlisted_target if {
    not allow with input as {"action_type": "navigate", "target": "admin-panel", "roles": ["mc-user"]}
}

test_deny_missing_role if {
    not allow with input as {"action_type": "navigate", "target": "collection", "roles": []}
}

test_deny_unknown_action if {
    not allow with input as {"action_type": "delete", "target": "collection", "roles": ["mc-user"]}
}
