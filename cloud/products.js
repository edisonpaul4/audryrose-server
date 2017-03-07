var _ = require('underscore');
var moment = require('moment');
var BigCommerce = require('node-bigcommerce');

var Product = Parse.Object.extend('Product');
var ProductVariant = Parse.Object.extend('ProductVariant');
var Category = Parse.Object.extend('Category');
var Classification = Parse.Object.extend('Classification');
var Department = Parse.Object.extend('Department');
var Designer = Parse.Object.extend('Designer');
var StyleNumber = Parse.Object.extend('StyleNumber');

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
const yearLetters = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z"];

/////////////////////////
//  CLOUD FUNCTIONS    //
/////////////////////////

Parse.Cloud.define("getProducts", function(request, response) {
  var totalProducts;
  var totalPages;
  var tabCounts;
  var currentPage = (request.params.page) ? parseInt(request.params.page) : 1;
  var currentSort = (request.params.sort) ? request.params.sort : 'date-added-desc';
  var search = request.params.search ? request.params.search : null;
  var subpage = request.params.subpage ? request.params.subpage : 'in-stock';
  var filters = request.params.filters ? request.params.filters : null;
  
  var productsQuery = new Parse.Query(Product);
  
  if (search) {
    var addPlural = function(term) { return term + 's'; };
    var toLowerCase = function(w) { return w.toLowerCase(); };
    
    var regex = new RegExp(search.toLowerCase(), 'gi');
    var searchTerms = search.split(' ');
    searchTerms = _.map(searchTerms, toLowerCase);
    var pluralTerms = _.map(searchTerms, addPlural);
    searchTerms = searchTerms.concat(pluralTerms);
    
    var searchSkuQuery = new Parse.Query(Product);
    searchSkuQuery.matches('sku', regex);
    var searchNameQuery = new Parse.Query(Product);
    searchNameQuery.containedIn('search_terms', searchTerms);
    var searchProductIdQuery = new Parse.Query(Product);
    searchProductIdQuery.equalTo('productId', parseFloat(search)); 
    productsQuery = Parse.Query.or(searchSkuQuery, searchNameQuery, searchProductIdQuery);
    
  } else {
    
    if (filters.designer && filters.designer != 'all') {
      var designerQuery = new Parse.Query(Designer);
      designerQuery.equalTo('name', filters.designer);
      productsQuery.matchesQuery('designer', designerQuery);
    }
    
    if (filters.price && filters.price != 'all') {
      var price = filters.price.split('-');
      var min = parseFloat(price[0]);
      var max = price[1] ? parseFloat(price[1]) : null;
      productsQuery.greaterThanOrEqualTo('price', min);
      if (max) productsQuery.lessThanOrEqualTo('price', max);
    }
    
    if (filters.class && filters.class != 'all') {
      var classQuery = new Parse.Query(Classification);
      classQuery.equalTo('name', filters.class);
      productsQuery.matchesQuery('classification', classQuery);
    }
    
  }
  productsQuery = getProductSort(productsQuery, currentSort);
  productsQuery.include('variants');
  productsQuery.include("department");
  productsQuery.include("classification");
  productsQuery.include("designer");
  productsQuery.limit(PRODUCTS_PER_PAGE);
  
  switch (subpage) {
    case 'in-stock':
      productsQuery.greaterThan('total_stock', 0);
      break;
    case 'need-to-order':
      productsQuery.greaterThan('variantsOutOfStock', 0);
      break;
    case 'waiting-to-receive':
      productsQuery.equalTo('hasVendorBuy', true);
      break;
    case 'being-resized':
      productsQuery.equalTo('hasResizeRequest', true);
      break;
    case 'all':
      break;
    default:
      break;
  }
  
//   if (request.params.sort && request.params.sort != 'all') recentJobs.equalTo("status", request.params.filter);
  
  
  Parse.Cloud.httpRequest({
    method: 'post',
    url: process.env.SERVER_URL + '/functions/getProductTabCounts',
    headers: {
      'X-Parse-Application-Id': process.env.APP_ID,
      'X-Parse-Master-Key': process.env.MASTER_KEY
    }
  }).then(function(response) {
    tabCounts = response.data.result;
    return productsQuery.count();
    
  }).then(function(count) {
    totalProducts = count;
    totalPages = Math.ceil(totalProducts / PRODUCTS_PER_PAGE);
    productsQuery.skip((currentPage - 1) * PRODUCTS_PER_PAGE);
    return productsQuery.find({useMasterKey:true});
    
  }).then(function(products) {
	  response.success({products: products, totalPages: totalPages, totalProducts: totalProducts, tabCounts: tabCounts});
	  
  }, function(error) {
	  response.error("Unable to get products: " + error.message);
	  
  });
});

Parse.Cloud.define("getProductTabCounts", function(request, response) {  
  
  var tabs = {};
  
  var inStockQuery = new Parse.Query(Product);
  inStockQuery.greaterThan('total_stock', 0);
  
  var needToOrderQuery = new Parse.Query(Product);
  needToOrderQuery.greaterThan('variantsOutOfStock', 0);
  
  var waitingToReceiveQuery = new Parse.Query(Product);
  waitingToReceiveQuery.equalTo('hasVendorBuy', true);
  
  var beingResizedQuery = new Parse.Query(Product);
  beingResizedQuery.equalTo('hasResizeRequest', true);
  
  var allQuery = new Parse.Query(Product);
  
  inStockQuery.count().then(function(count) {
    tabs.inStock = count;
    return needToOrderQuery.count();
    
  }).then(function(count) {
    tabs.needToOrder = count;
    return waitingToReceiveQuery.count();
    
  }).then(function(count) {
    tabs.waitingToReceive = count;
    return beingResizedQuery.count();
    
  }).then(function(count) {
    tabs.beingResized = count;
    return allQuery.count();
    
  }).then(function(count) {
    tabs.all = count;
	  response.success(tabs);
	  
  }, function(error) {
	  response.error("Unable to get product counts: " + error.message);
	  
  });
});

Parse.Cloud.define("getProductFilters", function(request, response) {  
  
  var designers = [];
  var designersQuery = new Parse.Query(Designer);
  designersQuery.ascending('name');
  designersQuery.limit(10000);
  
  var classes = [];
  var classesQuery = new Parse.Query(Classification);
  classesQuery.ascending('name');
  classesQuery.limit(10000);
  
  designersQuery.find({useMasterKey:true}).then(function(result) {
    designers = result;
    return classesQuery.find({useMasterKey:true});
    
  }).then(function(result) {
    classes = result;
	  response.success({designers: designers, classes: classes});
	  
  }, function(error) {
	  response.error("Unable to get designers: " + error.message);
	  
  });
});

Parse.Cloud.define("loadProduct", function(request, response) {
  var product = request.params.product;
  var added = false;
  
  var classes = [];
  var departments = [];
  var designers = [];
//   var updatedClassification;
  
  var classesQuery = new Parse.Query(Classification);
  classesQuery.limit(10000);
  classesQuery.find().then(function(result) {
    classes = result;
    
    var departmentsQuery = new Parse.Query(Department);
    departmentsQuery.limit(10000);
    return departmentsQuery.find();
    
  }).then(function(result) {
    departments = result;
    
    var designersQuery = new Parse.Query(Designer);
    designersQuery.limit(10000);
    return designersQuery.find();
    
  }).then(function(result) {
    designers = result;
    
    var productQuery = new Parse.Query(Product);
    productQuery.equalTo('productId', parseFloat(product.id));
    productQuery.include('department');
    productQuery.include('designer');
    productQuery.include('classification');
    return productQuery.first();
    
  }).then(function(productResult) {
    if (productResult) {
      console.log('Product ' + productResult.get('productId') + ' exists.');
      return createProductObject(product, classes, departments, designers, productResult);
    } else {
      console.log('Product ' + product.id + ' is new.');
      added = true;
      return createProductObject(product, classes, departments, designers);
    }
    
  }).then(function(productObject) {
//     if (productObject.classification) updatedClassification = productObject.classification;
    return productObject.save(null, {useMasterKey: true});
    
/*
  }).then(function(result) {
    if (updatedClassification) {
      return updatedClassification.save(null, {useMasterKey: true});
    } else {
      return true;
    }
*/
    
  }).then(function(result) {
    response.success({added: added});
    
  }, function(error) {
		response.error("Error saving product: " + error.message);
		
	});
});

Parse.Cloud.define("loadProductVariants", function(request, response) {
  console.log('updateProductVariants');
  var totalVariantsAdded = 0;
  var product;
  var bcProduct;
  var bcProductRules;
  var bcProductOptions;
  var allVariants = [];
  var productId = request.params.productId;
  var productQuery = new Parse.Query(Product);
  productQuery.equalTo('productId', parseInt(productId));
  productQuery.include('department');
  productQuery.include('classification');
  productQuery.include('designer');
  
  productQuery.first().then(function(result) {
    product = result;
    var productRequest = '/products/' + productId;
    return bigCommerce.get(productRequest);
    
  }).then(function(res) {
    bcProduct = res;
    var rulesRequest = '/products/' + productId + '/rules';
    return bigCommerce.get(rulesRequest);
  
  }).then(function(res) {
    bcProductRules = res;
    console.log('option_set: ' + JSON.stringify(bcProduct.option_set));
    console.log('options: ' + JSON.stringify(bcProduct.options));
    if (!bcProduct.option_set) return null;
    var optionSetsRequest = '/optionsets/' + bcProduct.option_set_id + '/options';
    return bigCommerce.get(optionSetsRequest);
  
  }).then(function(res) {
    bcProductOptions = res;
    
    var promise = Parse.Promise.as();
    
    ////////////////////////////////////////////////////////
    // Create a single variant if product has no options
    ////////////////////////////////////////////////////////
    if (!bcProductOptions) {
      var variantId = productId;
      promise = promise.then(function() {
        var variantQuery = new Parse.Query(ProductVariant);
        variantQuery.equalTo('variantId', variantId);
        return variantQuery.first();
          
      }).then(function(variantResult) {
        if (variantResult) {
          console.log('Variant ' + variantResult.get('variantId') + ' exists.');
          isNew = false;
          return createProductVariantObject(product, variantId, null, variantResult);
        } else {
          console.log('Variant ' + variantId + ' is new.');
          totalVariantsAdded++;
          return createProductVariantObject(product, variantId, null);
        }
        
      }).then(function(variantObject) {
        return variantObject.save(null, {useMasterKey: true});
        
      }).then(function(variantObject) {
        allVariants.push(variantObject);
        return variantObject;
        
      }, function(error) {
    		return "Error saving variant: " + error.message;
  			
  		});
      return promise;
    
    ////////////////////////////////////////////////////////
    // Create multiple variants if product has options
    ////////////////////////////////////////////////////////
    } else {
      
      // Create an array of all the option values
      var values = [];
      _.each(bcProductOptions, function(option) {
        var valueSet = [];
        _.each(option.values, function(optionValue) {
          optionValue.option_set_id = option.option_set_id;
          optionValue.option_id = option.option_id;
          optionValue.display_name = option.display_name;
          optionValue.value_sort_order = optionValue.sort_order;
          optionValue.sort_order = option.sort_order;
          optionValue.is_required = option.is_required;
          var priceAdjustment = optionPriceAdjustment(optionValue.option_id, optionValue.option_value_id, bcProductRules);
          if (priceAdjustment) {
            console.log('save price adjustment');
            optionValue.adjuster = priceAdjustment.adjuster;
            optionValue.adjuster_value = priceAdjustment.adjuster_value;
          }
          var isEnabled = optionIsPurchasingEnabled(optionValue.option_id, optionValue.option_value_id, bcProductRules);
          if (isEnabled) valueSet.push(optionValue);
        });
        if (valueSet.length) values.push(valueSet);
      });
      
      // Get all possible combinations of option value ids
      var valueIds = [];
      _.each(values, function(value) {
        var valueIdsSet = [];
        _.each(value, function(valueSet) {
          if (valueIdsSet.indexOf(valueSet.option_value_id) < 1) valueIdsSet.push(valueSet.option_value_id);
        });
        valueIds.push(valueIdsSet);
      });
      var variants = allCombinations(valueIds);
      
      // Populate and save the variants
      _.each(variants, function(valueIds) {
        if (!valueIds.length) valueIds = [valueIds];
        var variantOptions = [];
        var variantId = productId;
        var isNew = true;
        _.each(valueIds, function(valueId) {
          // Find the options data based on variantId
          _.each(values, function(valueSet) {
            
            _.each(valueSet, function(value) {
              if (valueId == value.option_value_id) {
                variantOptions.push(value);
                variantId += '-' + value.option_value_id;
              }
            });
          });
        });
        // Check if variant exists
        promise = promise.then(function() {
          var variantQuery = new Parse.Query(ProductVariant);
          variantQuery.equalTo('variantId', variantId);
          return variantQuery.first();
            
        }).then(function(variantResult) {
          if (variantResult) {
            console.log('Variant ' + variantResult.get('variantId') + ' exists.');
            isNew = false;
            return createProductVariantObject(product, variantId, variantOptions, variantResult);
          } else {
            console.log('Variant ' + variantId + ' is new.');
            totalVariantsAdded++;
            return createProductVariantObject(product, variantId, variantOptions);
          }
          
        }).then(function(variantObject) {
          return variantObject.save(null, {useMasterKey: true});
          
        }).then(function(variantObject) {
          allVariants.push(variantObject);
          return variantObject;
          
        }, function(error) {
      		return "Error saving variant: " + error.message;
    			
    		});
      });
      return promise;
    }
    
  }).then(function() {
		var now = new Date();
		product.set("variantsUpdatedAt", now);
    product.set('variants', allVariants);
    return product.save(null, {useMasterKey: true});
    
  }).then(function(savedProduct) {
    
    response.success(totalVariantsAdded);
    
  }, function(error) {
  	console.log(JSON.stringify(error));
		response.error(error.message);
  });
});

Parse.Cloud.define("reloadProduct", function(request, response) {
  var productId = parseInt(request.params.productId);
  var product;
  var bcProduct;

  var productQuery = new Parse.Query(Product);
  productQuery.equalTo('productId', productId);
  productQuery.first().then(function(result) {
    product = result;
    var productRequest = '/products/' + productId;
    console.log(productRequest);
    return bigCommerce.get(productRequest);
    
  }).then(function(res) {
    bcProduct = res;
    
    return Parse.Cloud.httpRequest({
      method: 'post',
      url: process.env.SERVER_URL + '/functions/loadProduct',
      headers: {
        'X-Parse-Application-Id': process.env.APP_ID,
        'X-Parse-Master-Key': process.env.MASTER_KEY
      },
      params: {
        product: bcProduct
      }
    });
    
  }).then(function(response) {
    
    return Parse.Cloud.httpRequest({
      method: 'post',
      url: process.env.SERVER_URL + '/functions/loadProductVariants',
      headers: {
        'X-Parse-Application-Id': process.env.APP_ID,
        'X-Parse-Master-Key': process.env.MASTER_KEY
      },
      params: {
        productId: productId
      }
    });
    
  }).then(function(response) {
    
    var productsQuery = new Parse.Query(Product);
    productsQuery.equalTo("productId", productId);
    productsQuery.include("variants");
    productsQuery.include("department");
    productsQuery.include("classification");
    productsQuery.include("designer");
    return productsQuery.first();
    
  }).then(function(product) {
	  response.success(product);
	  
  }, function(error) {
	  response.error("Unable to reload product: " + error.message);
	  
  });
});

Parse.Cloud.define("saveProductStatus", function(request, response) {
  var productId = parseInt(request.params.productId);
  var status = request.params.status;
  
  var isActive = (status == 'active') ? true : false;
  
  var productQuery = new Parse.Query(Product);
  productQuery.equalTo('productId', productId);
  productQuery.first().then(function(productResult) {
    if (productResult) {
      productResult.set('is_active', isActive);
      return productResult.save(null, {useMasterKey: true});
    } else {
      response.error("Error finding product: " + error.message);
    }
    
  }).then(function(productObject) {
    var productsQuery = new Parse.Query(Product);
    productsQuery.equalTo("productId", productId);
    productsQuery.include("variants");
    productsQuery.include("department");
    productsQuery.include("classification");
    productsQuery.include("designer");
    return productsQuery.first();
    
  }).then(function(product) {
	  response.success(product);
    
  }, function(error) {
		response.error("Error saving product: " + error.message);
		
	});
  
});

Parse.Cloud.define("saveVariant", function(request, response) {
  var objectId = request.params.objectId;
  var inventory = parseInt(request.params.inventory);
  var colorCode = request.params.colorCode;
  console.log(request.params);
  
  var variantQuery = new Parse.Query(ProductVariant);
  variantQuery.equalTo('objectId', objectId);
  variantQuery.first().then(function(variant) {
    if (variant) {
      if (inventory) variant.set('inventoryLevel', inventory);
      if (colorCode) variant.set('colorCode', colorCode);
      return variant.save(null, {useMasterKey: true});
    } else {
      response.error("Error finding variant: " + error.message);
    }
    
  }).then(function(variantObject) {
	  response.success(variantObject);
    
  }, function(error) {
		response.error("Error saving variant: " + error.message);
		
	});
  
});

Parse.Cloud.define("loadCategory", function(request, response) {
  var category = request.params.category;
  var added = false;
  
  var categoryQuery = new Parse.Query(Category);
  categoryQuery.equalTo('categoryId', parseFloat(category.id));
  categoryQuery.first().then(function(categoryResult) {
    if (categoryResult) {
      console.log('Category ' + categoryResult.get('categoryId') + ' exists.');
      return createCategoryObject(category, categoryResult).save(null, {useMasterKey: true});
    } else {
      console.log('Category ' + category.id + ' is new.');
      added = true;
      return createCategoryObject(category).save(null, {useMasterKey: true});
    }
    
  }).then(function(categoryObject) {
    response.success({added: added});
    
  }, function(error) {
		response.error("Error saving category: " + error.message);
		
	});
});


/////////////////////////
//  BEFORE SAVE        //
/////////////////////////

Parse.Cloud.beforeSave("Product", function(request, response) {
  var product = request.object;

  var toLowerCase = function(w) { return w.toLowerCase(); };

  var searchTerms = product.get("name").split(' ');
  searchTerms = _.map(searchTerms, toLowerCase);
  var stopWords = ["the", "in", "and", "with"];
  searchTerms = _.filter(searchTerms, function(w) { return !_.contains(stopWords, w); });
  console.log(searchTerms);
  product.set("search_terms", searchTerms);
  
  // Set whether to always resize (only if in Antiques "39" category)
  var categories = product.get('categories');
  var alwaysResize = categories.indexOf('39') >= 0;
  product.set("alwaysResize", alwaysResize);
  
  if (product.has('variants')) {
    var variants = product.get('variants');
    Parse.Object.fetchAll(variants).then(function(variantObjects) {
      var totalStock = 0;
      _.each(variantObjects, function(variant) {
        var inventory = variant.get('inventoryLevel');
        if (inventory) totalStock += inventory;
      });
      return totalStock;
    }).then(function(totalStock) {
      console.log('total stock: ' + totalStock);
      product.set('total_stock', totalStock);
      response.success();
    });
  } else {
    product.set('total_stock', 0);
    response.success();
  }
});


/////////////////////////
//  UTILITY FUNCTIONS  //
/////////////////////////

var optionIsPurchasingEnabled = function(option_id, option_value_id, rules) {
  var isEnabled = true;
  _.each(rules, function(rule) {
    if (rule.is_enabled && rule.is_purchasing_disabled) {
      _.each(rule.conditions, function(condition) {
//         console.log('check option match: ' + condition.product_option_id + '=' + option_id + ', and value match ' + condition.option_value_id + '=' + option_value_id);
        if (condition.option_value_id == option_value_id) {
          console.log('disable ' + option_value_id);
          isEnabled = false;
        }
      });
    }
  });
  return isEnabled;
};

var optionPriceAdjustment = function(option_id, option_value_id, rules) {
  var adjustment;
  _.each(rules, function(rule) {
    if (rule.is_enabled && rule.price_adjuster) {
      _.each(rule.conditions, function(condition) {
//         console.log('check value match ' + condition.option_value_id + '=' + option_value_id);
        if (condition.option_value_id == option_value_id) {
          console.log('adjust price ' + rule.price_adjuster.adjuster_value);
          adjustment = { "adjuster": rule.price_adjuster.adjuster, "adjuster_value": rule.price_adjuster.adjuster_value };
        }
      });
    }
  });
  return adjustment;
};

var allCombinations = function(array) {
  if(!array.length) {
    return [];
  }

  // wrap non-array values
  // e.g. ['x',['y','z']] becomes [['x'],['y','z']]
  array = array.map(function (item) {
    return item instanceof Array ? item : [item];
  });

  // internal recursive function
  function combine(list) {
    var prefixes, combinations;

    if(list.length === 1) {
      return list[0];
    }

    prefixes = list[0];
    combinations = combine(list.slice(1)); // recurse

    // produce a flat list of each of the current
    // set of values prepended to each combination
    // of the remaining sets.
    return prefixes.reduce(function (memo, prefix) {
      return memo.concat(combinations.map(function (combination) {
        return [prefix].concat(combination);
      }));
    }, []);
  }

  return combine(array);
}

var createProductObject = function(productData, classes, departments, designers, currentProduct) {
  var productObj = (currentProduct) ? currentProduct : new Product();
  
  productObj.set('productId', parseInt(productData.id));
  productObj.set('name', productData.name);
  productObj.set('sku', productData.sku);
  productObj.set('price', parseFloat(productData.price));
  productObj.set('cost_price', parseFloat(productData.cost_price));
  productObj.set('retail_price', parseFloat(productData.retail_price));
  productObj.set('sale_price', parseFloat(productData.sale_price));
  productObj.set('calculated_price', parseFloat(productData.calculated_price));
  productObj.set('is_visible', productData.is_visible == 'true');
  productObj.set('inventory_tracking', productData.inventory_tracking);
  productObj.set('total_sold', parseInt(productData.total_sold));
  productObj.set('date_created', moment.utc(productData.date_created, 'ddd, DD MMM YYYY HH:mm:ss Z').toDate());
  productObj.set('brand_id', parseInt(productData.brand_id));
  productObj.set('view_count', parseInt(productData.view_count));
  productObj.set('categories', productData.categories);
  productObj.set('date_modified', moment.utc(productData.date_modified, 'ddd, DD MMM YYYY HH:mm:ss Z').toDate());
  productObj.set('condition', productData.condition);
  productObj.set('is_preorder_only', productData.is_preorder_only == 'true');
  productObj.set('custom_url', productData.custom_url);
  productObj.set('option_set_id', parseInt(productData.option_set_id));
  productObj.set('primary_image', productData.primary_image);
  productObj.set('availability', productData.availability);
  
  if (!productObj.has('is_active')) productObj.set('is_active', true);
  
  _.each(classes, function(classObj) {
    if (classObj.get('category_id') && productData.categories.indexOf(classObj.get('category_id').toString()) >= 0) {
      productObj.set('classification', classObj);
    }
  });
  
  _.each(departments, function(departmentObj) {
    if (departmentObj.get('category_id') && productData.categories.indexOf(departmentObj.get('category_id').toString()) >= 0) {
      productObj.set('department', departmentObj);
    }
  });
  
  _.each(designers, function(designerObj) {
    if (productObj.get('brand_id') == designerObj.get('designerId')) {
      productObj.set('designer', designerObj);
    }
  });
  
  
  
  var designer = productObj.get('designer');
  var department = productObj.get('department');
  var classification = productObj.get('classification');
  
  // Create Style Number
	var styleNumber = '';
	var designerAbbreviation = designer ? designer.get('abbreviation') : '[DESIGNER]';
	styleNumber += designerAbbreviation;
	var dateCreated = productObj.get('date_created');
  var yearNum = parseFloat(moment(dateCreated.iso).format('YYYY')) - 2015;
  var yearLetter = yearLetters[yearNum];
  styleNumber += yearLetter;
  var season = parseFloat(moment(dateCreated.iso).format('M'));
  styleNumber += season;
  var departmentLetter = department ? department.get('letter') : '[DEPARTMENT]';
  styleNumber += departmentLetter;
  var classStartId = classification ? classification.get('start_id') : 0;
  console.log('classStartId: ' + classStartId);
  var classificationNumber;
  
  var promise = Parse.Promise.as();
  promise = promise.then(function() {
    
    console.log('search for style number: ' + styleNumber);
    var styleNumbersQuery = new Parse.Query(StyleNumber);
    styleNumbersQuery.limit(10000);
    styleNumbersQuery.equalTo('designerAbbreviation', designerAbbreviation);
    styleNumbersQuery.equalTo('yearLetter', yearLetter);
    styleNumbersQuery.equalTo('season', season);
    styleNumbersQuery.equalTo('department', departmentLetter);
    styleNumbersQuery.equalTo('classification', classStartId);
    return styleNumbersQuery.first();
  
  }).then(function(result) {
    var styleNumberObj;
    
    if (result) {
      console.log('style number exists');
      styleNumberObj = result;
      if (!productObj.has('classificationNumber')) {
        styleNumberObj.increment('classificationCounter');
        classificationNumber = styleNumberObj.get('classificationCounter');
      } else {
        classificationNumber = productObj.get('classificationNumber');
      }
    } else {
      console.log('style number is new');
      styleNumberObj = new StyleNumber();
      styleNumberObj.set('designerAbbreviation', designerAbbreviation);
      styleNumberObj.set('yearLetter', yearLetter);
      styleNumberObj.set('season', season);
      styleNumberObj.set('department', departmentLetter);
      styleNumberObj.set('classification', classStartId);
      styleNumberObj.set('classificationCounter', classStartId);
      classificationNumber = classStartId;
    }
    styleNumber += classificationNumber;
    console.log('save: ' + styleNumber);
    return styleNumberObj.save(null, {useMasterKey: true});
    
  }).then(function(result) {
    productObj.set('classificationNumber', classificationNumber);
    productObj.set('styleNumber', styleNumber);
    return productObj;
  });
    
  return promise;
}

var createProductVariantObject = function(product, variantId, variantOptions, currentVariant) {
  var variantObj = (currentVariant) ? currentVariant : new ProductVariant();
  
  variantObj.set('productId', product.get('productId'));
  
  if (!currentVariant) {
    variantObj.set('variantId', variantId);
  }
  
  var optionValueIds = [];
	if (variantOptions) {
		variantOptions.map(function(variantOption, i) {
  		optionValueIds.push(variantOption.option_value_id);
  		if (variantOption.option_id === 32 || variantOption.option_id === 18) {
    		variantObj.set('size_label', variantOption.label);
    		variantObj.set('size_value', variantOption.value);
  		}
  		if (variantOption.option_id === 3 || variantOption.option_id === 31 || variantOption.option_id === 36 || variantOption.option_id === 30) {
    		variantObj.set('color_label', variantOption.label);
    		variantObj.set('color_value', variantOption.value);
  		}
  		if (variantOption.option_id === 33) {
    		variantObj.set('gemstone_label', variantOption.label);
    		variantObj.set('gemstone_value', variantOption.value);
  		}
  		if (variantOption.option_id === 27) {
    		variantObj.set('font_label', variantOption.label);
    		variantObj.set('font_value', variantOption.value);
  		}
  		if (variantOption.option_id === 26) {
    		variantObj.set('letter_label', variantOption.label);
    		variantObj.set('letter_value', variantOption.value);
  		}
  		if (variantOption.option_id === 35) {
    		variantObj.set('length_label', variantOption.label);
    		variantObj.set('length_value', variantOption.value);
  		}
  		if (variantOption.option_id === 34) {
    		variantObj.set('singlepair_label', variantOption.label);
    		variantObj.set('singlepair_value', variantOption.value);
  		}
  		return variantOption;
		});
		
		variantObj.set('variantOptions', variantOptions);
	}
	variantObj.set('optionValueIds', optionValueIds);
	
	// Duplicate some properties from parent product
	if (product.has('designer')) variantObj.set('designer', product.get('designer'));
	if (product.has('alwaysResize')) variantObj.set('alwaysResize', product.get('alwaysResize'));
  if (product.has('styleNumber')) variantObj.set('styleNumber', product.get('styleNumber'));
  
  return variantObj;
  
}

var getProductSort = function(productsQuery, currentSort) {
  switch (currentSort) {
    case 'date-added-desc':
      productsQuery.descending("date_created");
      break;
    case 'date-added-asc':
      productsQuery.ascending("date_created");
      break;
    case 'price-desc':
      productsQuery.descending("price");
      break;
    case 'price-asc':
      productsQuery.ascending("price");
      break;
    case 'stock-desc':
      productsQuery.descending("total_stock");
      break;
    case 'stock-asc':
      productsQuery.ascending("total_stock");
      break;
    default:
      productsQuery.descending("date_created");
      break;
  }
  return productsQuery;
}

var createCategoryObject = function(categoryData, currentCategory) {
  var categoryObj = (currentCategory) ? currentCategory : new Category();
  
  categoryObj.set('categoryId', parseInt(categoryData.id));
  categoryObj.set('parent_id', parseInt(categoryData.parent_id));
  categoryObj.set('name', categoryData.name);
  categoryObj.set('parent_category_list', categoryData.parent_category_list);
  return categoryObj;
}