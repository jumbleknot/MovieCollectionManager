package mcm.agent_ui_action

import rego.v1

default allow := false

navigable := {"home", "collection", "movie-detail", "profile"}

prefillable := {"add-movie"}

has_mc_user if {
    some r in input.roles
    r == "mc-user"
}

has_mc_user if {
    some r in input.roles
    r == "mc-admin"
}

allow if {
    input.action_type == "navigate"
    navigable[input.target]
    has_mc_user
}

allow if {
    input.action_type == "prefill"
    prefillable[input.target]
    has_mc_user
}
