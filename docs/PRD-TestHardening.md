Feature: Test Hardening

I am using SDD with Claude Code to define, design, build, and test an application. I would like to be more efficient in this process by
    - defining better and more thorough test cases up front (before implementation begins) that catch bugs during implementation without a human having to validate the application
    - ensuring that test cases cover multiple data scenarios, not just testing a couple of attributes or a couple of combinations
    - ensuring that test cases create a base data set for use of repeated testing without having to recreate that base data set every time (and check that the base data set exists as expected, and if not, then it creates the base data set)
    - ensuring that test cases clean up after themselves for any additions of data that is outside of the base data set
    - ensuring that e2e test cases provide equal coverage (where possible) of mobile and web clients
    - running the right test cases at the right time (e.g., if a test case fails, fix the issue and validate that fix by rerunning just the failed test first before re-running the full e2e tests; don't run test cases for user registration until the final validation if the user registration code hasn't been touched in this feature branch)
    - ensuring that after Claude Code believes it has fixed all issues that it runs all tests to validate everything is working
    - ensuring that testing is as repeatable and consistent as possible (e.g., common instructions for how to test and in what order)
    - ensuring that testing is as token efficient as possible (see project file "Vibe-coders best-practice.docx")

I have copied excerpts from my git repo into this project.
    - "constitution.md" describes my SDD principles that are to be followed
    - "MCM-Architecture.md" describes the architecture of the software being built
    - "specs/" folder has examples of the features I have implemented so far and the descriptions of what tests were to be created
    - "tests/" folder has the integration, load, and e2e tests (I didn't include the unit tests)
    - "CLAUDE.md" tells Claude Code how to behave in this repo

I would like you to propose a strategy that I could implement to achieve better agentic coding efficiency based on the above
