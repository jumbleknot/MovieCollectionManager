package mcm.agent_token_exchange

import rego.v1

test_allow_mc_service_agent_origin if {
    allow with input as {"user_id": "u1", "audience": "mc-service", "agent_origin": true}
}
test_deny_wrong_audience if {
    not allow with input as {"user_id": "u1", "audience": "other", "agent_origin": true}
}
test_deny_non_agent_origin if {
    not allow with input as {"user_id": "u1", "audience": "mc-service", "agent_origin": false}
}
