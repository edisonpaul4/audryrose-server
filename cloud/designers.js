var _ = require('underscore');
var moment = require('moment');
var BigCommerce = require('node-bigcommerce');

var Product = Parse.Object.extend('Product');
var Designer = Parse.Object.extend('Designer');

// CONFIG
// Set up Bigcommerce API
var bigCommerce = new BigCommerce({
  logLevel: 'error',
  clientId: process.env.BC_CLIENT_ID,
  secret: process.env.BC_CLIENT_SECRET,
  callback: 'https://audryrose.herokuapp.com/auth',
  responseType: 'json'
});
bigCommerce.config.accessToken = process.env.BC_ACCESS_TOKEN;
bigCommerce.config.storeHash = process.env.BC_STORE_HASH;
const BIGCOMMERCE_BATCH_SIZE = 250;
const PRODUCTS_PER_PAGE = 50;

/////////////////////////
//  CLOUD FUNCTIONS    //
/////////////////////////

Parse.Cloud.define("loadDesigner", function(request, response) {
  var designer = request.params.designer;
  var added = false;
  
  var designerQuery = new Parse.Query(Designer);
  designerQuery.equalTo('designerId', parseInt(designer.id));
  designerQuery.first().then(function(designerResult) {
    if (designerResult) {
      console.log('designer ' + designerResult.get('designerId') + ' exists.');
      return createDesignerObject(designer, designerResult).save(null, {useMasterKey: true});
    } else {
      console.log('designer ' + designer.id + ' is new.');
      added = true;
      return createDesignerObject(designer).save(null, {useMasterKey: true});
    }
    
  }).then(function(designerObject) {
    response.success({added: added});
    
  }, function(error) {
    response.error("Error saving designer: " + error.message);
		
	});
});


/////////////////////////
//  UTILITY FUNCTIONS  //
/////////////////////////

var createDesignerObject = function(designerData, currentDesigner) {
  var designer = (currentDesigner) ? currentDesigner : new Designer();
  
  designer.set('designerId', parseInt(designerData.id));
  designer.set('name', designerData.name);
  if (!designer.get('abbreviation')) {
    var abbreviation = designerData.name;
    abbreviation = abbreviation.toUpperCase();
    abbreviation = abbreviation.replace(/-/g, '');
    abbreviation = abbreviation.replace(/\./g, '');
    abbreviation = abbreviation.replace(/\+/g, '');
    abbreviation = abbreviation.replace(/\(|\)/g, '');
    abbreviation = abbreviation.replace(/ /g, '');
    designer.set('abbreviation', abbreviation.substring(0, 3));
  }
  designer.set('image_file', designerData.image_file);
  
  return designer;
}