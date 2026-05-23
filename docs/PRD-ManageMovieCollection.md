Feature: Manage Movie Collection

Enables a logged-in user to manage their movie collections.

Target Users: All

Core Capabilities:

- A user can be the owner for 0 or more movie collections
- Each movie collection has the following attributes:
  - `collectionId` [1] - system generated unique identifier (required)
  - `name` [1] - name of the movie collection (required)
  - `default` [1] - boolean value depicting if this movie collection is the user's default movie collection; value defaulted to no (required)
  - `description` [0..1] - a textual description of the movie collection
- A user cannot save (create, update) a movie collection they own with the same name as another movie collection they own
- A user can either have no set default movie collection, or 1 default movie collection - the user cannot have more than 1 default movie collection, so setting a movie collection as default when another movie collection is set as default will remove default status from the other movie collection
- A movie collection can contain 0 or more movies
- A movie is comprised of the following attributes:
  - `movieId` [1] - system generated unique identifier (required)
  - `title` [1] - current movie title, generally in English language (required)
  - `year` [1] - original release year (required)
  - `contentType` [1] - the type of content with valid values being: movie, series, concert (required)
  - `language` [1] - the primary language of the movie (required)
  - `owned` [1] - boolean value depicting if the movie is owned or not (required)
  - `ripped` [1] - boolean value depicting if the movie is ripped to owner's movie server; value defaulted to no (required)
  - `childrens` [1] - boolean value depicting if the movie is a children's movie or not; value defaulted to no (required)
  - `externalId` [0..n] - parent for attributes identifying each enteral identifier for this movie
    - `externalIdSystem` [1] - the system the external id exists in (e.g., IMDB,TMDB)
    - `externalIdUniqueId` [1] - the unique identifier in the external system
    - `externalIdURL` [0..1] - if available, the URL to the movie in the external system
  - `originalTitle` [0..1] - title when movie was originally released in original language - if different from current title
  - `releaseDate` [0..1] - the original release date in format YYYY-MM-DD
  - `outline` [0..1] - the brief outline of the movie
  - `plot` [0..1] - a brief desscription of the movie's plot
  - `runtime` [0..1] - the duration of the movie in minutes
  - `rated` [0..1] - the USA rating for the movie if available
  - `director` [0..n] - the name of director(s) of the movie
  - `actor` [0..n] - the name of actor(s) in the movie
  - `movieSet` [0..1] - the name of the movie set the movie is a part of (only if the movie belongs to a set)
  - `tag` [0..n] - the name of the tag(s) associated with the movie
  - `genre` [0..n] - the name of the genre(s) associated with the movie
  - `ownedMedia` [0..n] - the type(s) of physical media version(s) of the movie owned with valid values being: DVD, Blu-Ray, Blu-Ray 3D, UHD Blu-Ray
  - `ripQuality` [0..n] - the quality of ripped version(s) of the movie on the owner's server with valid values being: DVD, Blu-Ray, Blu-Ray 3D, UHD Blu-Ray
- A logged-in user can create a new movie collection, add movies to the collection, browse and search/filter all movies in the collection, view an individual movie in the collection, edit movies in the collection, remove movies from the collection, set a default collection to load when logging into the app, and remove an entire movie collection
- A user will be warned if they request to remove a movie from a movie collection that the movie will not be recoverable and all data for that movie will be lost; the user must confirm to delete and lose all data for the movie before it is removed
- A user will be warned if they request to remove a movie collection that the movie collection will not be recoverable and all data for that movie collection will be lost; the user must confirm to delete and lose all data for the movie collection before it is removed

Security:  A user must have a valid login and roles as already implemented in previous feature to access protected screens and services.  A user only has access to movie collections that they create (sharing movie collection to be implemented in future feature).

Success Criteria:

- A user cannot access any movie collections if they are not logged in.
- A logged in user only has access to movie collections that they created and cannot see any other user's movie collections.
- After successfully logging into the app, the home page will either show the home screen (if no default movie collection set) or load that user's default movie collection.
- From the home screen a user can choose to:
  - create a new movie collection
  - browse existing movie collections they own then select and load a movie collection (navigate to movie collection screen and load selected movie collection)
  - browse existing movie collections they own then select one and set as default movie collection (max 1 default movie collection allowed at a time - the new default replaces the previous default)
  - browse existing movie collections they own then select one and delete the movie collection (collection is only deleted after confirmation from user that they acknowledge they will lose all data from the movie collection)
- From the movie collection screen a user can choose to:
  - create a new movie in this collection (load new movie in movie details screen)
  - browse existing movies in this collection by: title, year, contentType, owned, ownedMedia, ripped, ripQuality
  - choose additional movie attributes to show when browsing movies in the collection
  - filter the list of movies in the collection by searching for movies by: title, originalTitle, director, actor, movieSet, tag, outline, plot
  - filter the list of movies in the collection by selecting from available values for: contentType (movie, series, concert), genre (distinct values from movies loaded in collection), childrens (yes, no), rated (distinct values from movies loaded in collection), language (distinct values from movies loaded in collection), decade (derived values from movies loaded in the collection e.g., 1980's returns all movies with year between 1980 and 1989 inclusive), owned (yes, no), ownedMedia (DVD, Blu-Ray, Blu-Ray 3D, UHD Blu-Ray), ripped (yes, no), ripQuality (DVD, Blu-Ray, Blu-Ray 3D, UHD Blu-Ray)
  - view a movie's details (load movie in movie details screen)
- From the movie details screen a user can choose to
  - view movie attributes
  - edit movie attributes
  - save movie (must validate values)
  - remove movie (movie is only deleted after confirmation from user that they acknowledge they will lose all data from the movie)

Constraints: Follow all constraints of [MCM Architecture](MCM-Architecture.md)

Out of Scope: Sharing movie collection with other users will be a future feature. Loading movie attributes from external movie metadata will be part of a future feature.
