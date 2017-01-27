var _ = require('underscore');
var moment = require('moment');
var request = require('request');
var cheerio = require('cheerio');

// CONFIG


/////////////////////////
//  BACKGROUND JOBS    //
/////////////////////////

Parse.Cloud.job("schedulerJob", function(request, status) {
  console.log("\n\n----==== Initialized schedulerJob ====----");
	status.success("Complete!");
});

/////////////////////////
//  CLOUD FUNCTIONS    //
/////////////////////////

Parse.Cloud.define("getRecentJobs", function(request, response) {
  // Get most recent jobs
  var recentJobs = new Parse.Query(JobStatus);
  recentJobs.descending("createdAt");
  if (request.params.filter && request.params.filter != 'all') recentJobs.equalTo("status", request.params.filter);
  
  recentJobs.find({useMasterKey:true}).then(function(jobs) {
	  response.success(jobs);
	  
  }, function(error) {
	  response.error("Unable to save the model: " + error.message);
	  
  });
});

/////////////////////////
//  UTILITY FUNCTIONS  //
/////////////////////////

