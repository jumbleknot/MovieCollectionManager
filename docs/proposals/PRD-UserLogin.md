Feature: User Login

Enables a user to self-register and login to the MCM app.

Target Users: All

Core Capabilities: When the application starts users are presented with the option to create an account or login.  A new user is able to self-register and create an account.  New accounts are defaulted to the role `mc-user`.  Any user with valid account is able to login and access the application.  Once a user is successfully validated, they are navigated to the home screen.  The application navigation bar has options for home and profile.  The user is able to navigate to the profile page by selecting profile from the navigation bar.  In the profile page the user is able to see what account they are logged in as, what client roles they are assigned, user details, and an option to log out.  Selecting log out will log out the user from the application and bring them to the login screen.

Security: The application should validate membership in one of the following client roles: `mc-admin`, `mc-user`.

Success Criteria:  

- A new user is able to self-register and create an account.  Validate that new users are defaulted to the role `mc-user`.
- An existing user with an account is able to login when they provide valid credentials.
- An existing user with an account is not able to login when they provide invalid credentials.
- A user who has not logged in is not able to access the rest of the application.  
- A user who is logged in is able to continue into the application.  Validate that the user can access the profile page.
- The profile page shows what account they are logged in as, what client roles they are assigned, and user details.
- The user is able to log out from the profile page.  Once logged out, the user is taken back to login screen and cannot access the rest of the application until they log in again.

Constraints: Follow all constraints of [MCM Architecture](MCM-Architecture.md)

Out of Scope: The functionality of the home screen is out of scope.  The application navigation bar other than home and profile is out of scope.
