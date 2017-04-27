var _ = require('underscore');
var moment = require('moment');
var BigCommerce = require('node-bigcommerce');
var bugsnag = require("bugsnag");

var Product = Parse.Object.extend('Product');
var Designer = Parse.Object.extend('Designer');
var Vendor = Parse.Object.extend('Vendor');

// CONFIG
bugsnag.register("a1f0b326d59e82256ebed9521d608bb2");
// Set up Bigcommerce API
var bigCommerce = new BigCommerce({
  logLevel: 'errors',
  clientId: process.env.BC_CLIENT_ID,
  secret: process.env.BC_CLIENT_SECRET,
  callback: 'https://audryrose.herokuapp.com/auth',
  responseType: 'json'
});
bigCommerce.config.accessToken = process.env.BC_ACCESS_TOKEN;
bigCommerce.config.storeHash = process.env.BC_STORE_HASH;
const BIGCOMMERCE_BATCH_SIZE = 250;
const DESIGNERS_PER_PAGE = 50;

/////////////////////////
//  CLOUD FUNCTIONS    //
/////////////////////////

Parse.Cloud.define("getDesigners", function(request, response) {
  var totalDesigners;
  var designers;
  var totalPages;
  var currentPage = (request.params.page) ? parseInt(request.params.page) : 1;
  var currentSort = (request.params.sort) ? request.params.sort : 'name-asc';
  var subpage = request.params.subpage ? request.params.subpage : 'all';
  
  var designersQuery = new Parse.Query(Designer);
  designersQuery = getDesignerSort(designersQuery, currentSort);
  
  switch (subpage) {
    case 'all':
//       designersQuery.equalTo('status', 'Shipped');
      break; 
    case 'ordered':
//       designersQuery.equalTo('status', 'Shipped');
      break; 
    case 'resizing':
//       designersQuery.equalTo('status', 'Shipped');
      break; 
  }
  
  designersQuery.limit(10000);
  designersQuery.include('vendors');
  designersQuery.include('vendors.pendingOrder');
  designersQuery.include('vendors.pendingOrder.vendorOrderVariants');
  designersQuery.include('vendors.pendingOrder.vendorOrderVariants.variant');
  
  designersQuery.count().then(function(count) {
    totalDesigners = count;
    totalPages = Math.ceil(totalDesigners / 10000);
    designersQuery.skip((currentPage - 1) * 10000);
    return designersQuery.find({useMasterKey:true});
    
  }).then(function(results) {
    designers = results;
    
    var productsQuery = new Parse.Query(Product);
    productsQuery.include('variants');
    productsQuery.include("department");
    productsQuery.include("classification");
    productsQuery.include("designer");
    productsQuery.include("vendor");
    productsQuery.include("vendor.pendingOrder");
    productsQuery.include("vendor.pendingOrder.vendorOrderVariants");
    productsQuery.include("bundleVariants");
    productsQuery.limit(10000);
    
    return productsQuery.find();
    
  }).then(function(results) {
    products = results;
    
	  response.success({designers: designers, products: products, totalPages: totalPages});
	  
  }, function(error) {
	  logError(error);
	  response.error(error.message);
	  
  });
});

/*
Parse.Cloud.define("saveDesigner", function(request, response) {
  var objectId = request.params.objectId;
  var email = request.params.email;
  var designerToUpdate;
  
  var designerQuery = new Parse.Query(Designer);
  designerQuery.equalTo('objectId', objectId);
  designerQuery.first().then(function(designer) {
    if (designer) designerToUpdate = designer;
    
    if (designer) {
      if (email && email != '') {
        designerToUpdate.set('email', email);
      } else {
        designerToUpdate.unset('email');
      }
    }
    return designerToUpdate.save(null, {useMasterKey: true});
    
  }).then(function(designerObject) {
	  response.success(designerObject);
    
  }, function(error) {
		logError(error);
		response.error(error.message);
		
	});
  
});
*/

Parse.Cloud.define("loadDesigner", function(request, response) {
  var designer = request.params.designer;
  var designerObj;
  var added = false;
  
  var designerQuery = new Parse.Query(Designer);
  designerQuery.equalTo('designerId', parseInt(designer.id));
  designerQuery.include('vendor');
  designerQuery.first().then(function(designerResult) {
    if (designerResult) {
      logInfo('designer ' + designerResult.get('designerId') + ' exists.');
      return createDesignerObject(designer, designerResult).save(null, {useMasterKey: true});
    } else {
      logInfo('designer ' + designer.id + ' is new.');
      added = true;
      return createDesignerObject(designer).save(null, {useMasterKey: true});
    }
    
  }).then(function(designerObject) {
    designerObj = designerObject;
    
    if (designerObject.has('vendors')) {
      logInfo('Designer has a vendor');
      return designerObject.get('vendors');
      
    } else if (designerObject.get('designerId') == 47) {
      logInfo('Designer is Antiques and has multiple vendors');
      return [];
      
    } else {
      logInfo('Designer is self vendor');
      var vendor = new Vendor();
      vendor.set('name', designerObject.get('name'));
      vendor.set('designers', [designerObject]);
      return [vendor];
    }
    
  }).then(function(vendors) {
      designerObj.set('vendors', vendors);
      return designerObj.save(null, {useMasterKey: true});
    
  }).then(function(result) {
    response.success({added: added});
    
  }, function(error) {
    logError(error);
    response.error(error.message);
		
	});
});

Parse.Cloud.define("saveVendor", function(request, response) {
  var designerId = request.params.data.designerId;
  var vendorId = request.params.data.vendorId;
  var name = request.params.data.name;
  var firstName = request.params.data.firstName;
  var lastName = request.params.data.lastName;
  var email = request.params.data.email;
  var designer;
  
  var designerQuery = new Parse.Query(Designer);
  designerQuery.equalTo('objectId', designerId);
  designerQuery.include('vendors');
  designerQuery.first().then(function(result) {
    designer = result;
    
    if (vendorId) {
      var vendorQuery = new Parse.Query(Vendor);
      vendorQuery.equalTo('objectId', vendorId);
      vendorQuery.include('designers');
      return vendorQuery.first();
    } else {
      var vendor = new Vendor();
      return vendor.save(null, {useMasterKey: true});
    }
    
  }).then(function(vendor) {
    
    if (name && name != '') {
      vendor.set('name', name);
    } else {
      vendor.unset('name');
    }
    if (firstName && firstName != '') {
      vendor.set('firstName', firstName);
    } else {
      vendor.unset('firstName');
    }
    if (lastName && lastName != '') {
      vendor.set('lastName', lastName);
    } else {
      vendor.unset('lastName');
    }
    if (email && email != '') {
      vendor.set('email', email);
    } else {
      vendor.unset('email');
    }
    if (name && name != '') {
      vendor.set('email', email);
    } else {
      vendor.unset('email');
    }
    
    if (vendor.has('designers')) {
      vendor.addUnique('designers', designer);
    } else {
      vendor.set('designers', [designer]);
    }
    
    return vendor.save(null, {useMasterKey: true});
    
    
  }).then(function(vendorObject) {
    
    if (designer.has('vendors')) {
      designer.addUnique('vendors', vendorObject);
    } else {
      designer.set('vendors', [vendorObject]);
    }
    
    return designer.save(null, {useMasterKey: true});
    
  }).then(function(designerObject) {
    
    designerQuery = new Parse.Query(Designer);
    designerQuery.equalTo('objectId', designerId);
    designerQuery.include('vendors');
    return designerQuery.first();
    
  }).then(function(designerObject) {
    response.success(designerObject);
    
  }, function(error) {
		logError(error);
		response.error(error.message);
		
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

var getDesignerSort = function(designersQuery, currentSort) {
  switch (currentSort) {
    case 'name-desc':
      designersQuery.descending("name");
      break;
    case 'name-asc':
      designersQuery.ascending("name");
      break;
    default:
      designersQuery.ascending("name");
      break;
  }
  return designersQuery;
}

var logInfo = function(i, alwaysLog) {
  if (process.env.NODE_ENV == 'development' || process.env.DEBUG == 'true' || alwaysLog) console.info(i);
}

var logError = function(e) {
  var msg = JSON.stringify(e);
  console.error(msg);
	bugsnag.notify(msg);
}