var _ = require('underscore');
var BigCommerce = require('node-bigcommerce');

var Product = Parse.Object.extend('Product');
var ProductVariant = Parse.Object.extend('ProductVariant');

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

Parse.Cloud.define("getProducts", function(request, response) {
  var totalProducts;
  var totalPages;
  var currentPage = (request.params.page) ? parseInt(request.params.page) : 1;
  
  var productsQuery = new Parse.Query(Product);
  productsQuery.descending("date_created");
  productsQuery.include('variants');
  productsQuery.limit(PRODUCTS_PER_PAGE);
//   if (request.params.sort && request.params.sort != 'all') recentJobs.equalTo("status", request.params.filter);
  
  productsQuery.count().then(function(count) {
    totalProducts = count;
    totalPages = Math.ceil(totalProducts / PRODUCTS_PER_PAGE);
    productsQuery.skip((currentPage - 1) * PRODUCTS_PER_PAGE);
    return productsQuery.find({useMasterKey:true});
    
  }).then(function(products) {
	  response.success({products: products, totalPages: totalPages});
	  
  }, function(error) {
	  response.error("Unable to get products: " + error.message);
	  
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
  
  productQuery.first().then(function(result) {
    product = result;
    var productRequest = '/products/' + productId;
    console.log(productRequest);
    return bigCommerce.get(productRequest);
    
  }).then(function(res) {
    bcProduct = res;
    var rulesRequest = '/products/' + productId + '/rules';
    console.log(rulesRequest);
    return bigCommerce.get(rulesRequest);
  
  }).then(function(res) {
    bcProductRules = res;
    console.log('option_set: ' + JSON.stringify(bcProduct.option_set));
    console.log('options: ' + JSON.stringify(bcProduct.options));
    if (!bcProduct.option_set) return null;
    var optionSetsRequest = '/optionsets/' + bcProduct.option_set_id + '/options';
    console.log(optionSetsRequest);
    return bigCommerce.get(optionSetsRequest);
  
  }).then(function(res) {
    bcProductOptions = res;
    
    var promise = Parse.Promise.as();
    
    // Create a single variant if product has no options
    if (!bcProductOptions) {
      var variantId = productId;
      promise = promise.then(function() {
        return createProductVariantObject(variantId, null).save(null, {useMasterKey: true});
        
      }).then(function(variantObject) {
        allVariants.push(variantObject);
        totalVariantsAdded++;
        return variantObject;
        
      }, function(error) {
    		return "Error saving variant: " + error.message;
  			
  		});
      return promise;
    }
    
    
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
          return createProductVariantObject(variantId, variantOptions, variantResult).save(null, {useMasterKey: true});
        } else {
          console.log('Variant ' + variantId + ' is new.');
          totalVariantsAdded++;
          return createProductVariantObject(variantId, variantOptions).save(null, {useMasterKey: true});
        }
        
      }).then(function(variantObject) {
        allVariants.push(variantObject);
        return variantObject;
        
      }, function(error) {
    		return "Error saving variant: " + error.message;
  			
  		});
    });
    return promise;
    
  }).then(function() {
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
  
  Parse.Cloud.httpRequest({
    method: 'post',
    url: process.env.SERVER_URL + '/functions/loadProductVariants',
    headers: {
      'X-Parse-Application-Id': process.env.APP_ID,
      'X-Parse-Master-Key': process.env.MASTER_KEY
    },
    params: {
      productId: productId
    }
  }).then(function(response) {
    
    var productsQuery = new Parse.Query(Product);
    productsQuery.equalTo("productId", productId);
    productsQuery.include("variants");
    return productsQuery.first();
    
  }).then(function(product) {
	  response.success(product);
	  
  }, function(error) {
	  response.error("Unable to reload product: " + error.message);
	  
  });
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

var createProductVariantObject = function(variantId, variantOptions, currentVariant) {
  var variantObj = (currentVariant) ? currentVariant : new ProductVariant();
  
  if (!currentVariant) {
    variantObj.set('variantId', variantId);
  
  	if (variantOptions) {
  		variantOptions.map(function(variantOption, i) {
    		console.log(variantOption);
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
  	}
  }
  
  if (variantOptions) variantObj.set('variantOptions', variantOptions);
  
  return variantObj;
}