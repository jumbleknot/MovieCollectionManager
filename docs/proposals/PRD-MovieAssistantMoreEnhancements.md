# More Movie Assistant Enhancements

I have some enhancements and some bug fixes for prior issues I noticed (see 4 items below).  Let's run SDD for an enhancement feature.
1. when I search for a movie > search web > select movie version > the movie card only has option to add to collection, it should also have option (disambiguation button) to cancel which should exit search
2. when I add a movie to my collection from TMDB it asks me if I own the movie.  If the answer is "no" it should just add the movie as not owned (current functionality), but if the answer is "yes" it should also present a multi-select for media types and then ask me if it is ripped.  If ripped is "no" then add as not ripped, but if ripped is "yes" then add multi-select buttons to allow user to select the rip quality.  Then after the movie is added, it should navigate me to the movie detail page for me to review (no change, this is current functionality)
3. when importing the movie "Three Billboards Outside Ebbing, Missouri " from a spreadsheet the assistant asks me appropriate questions on the "," to understand if there is an article and what the correct movie name should be, but then it goes into a loop and hangs.  Let's make sure we trimming whitespace at the end of strings when importing, but this may not be the issue and may require other fixes. 
assistant: How should "Three Billboards Outside Ebbing, Missouri " be sorted?
me: Three Billboards Outside Ebbing, Missouri
assistant: How should "Three Billboards Outside Ebbing, Missouri " be sorted?
4. "navigate to <collection name>" results in response of "Sorry — I couldn't complete that just now. Please try again.".  This functionality used to work and navigate me to a collection.
5. when importing a large number of movies (over 2000) from spreadsheet ("docs\test-data\large-import-sample.xlsx" tab "Movies"), the import hangs
